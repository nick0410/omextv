import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "../lib/socket";
import api from "../lib/axios";
import type {
  CallPhase,
  ChatMessage,
  IceConfig,
  MatchFilters,
  MatchFound,
  PartnerProfile,
  QueueError,
  QueueJoined,
} from "../lib/types";

/**
 * The whole call lifecycle in one place.
 *
 * Matchmaking, signalling and the peer connection are split across separate
 * hooks in a lot of codebases, but here they are one state machine: a
 * `match-found` immediately drives an offer, a `partner-left` must tear the
 * peer connection down, and a skip has to do both in order. Keeping them
 * together is what makes that ordering enforceable rather than emergent.
 */

const FALLBACK_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Turn a getUserMedia rejection into something the user can act on.
 *
 * The distinction matters most on phones: "another app is using the camera"
 * is common there and has a completely different fix from "you denied
 * permission", but both arrive as a rejected promise.
 */
/**
 * Explain a failed peer connection in terms the user can act on.
 *
 * "failed" almost always means ICE found no usable path. Whether a relay
 * candidate was gathered separates "no TURN configured" from "TURN is
 * configured but did not work", which need different fixes.
 */
function connectionFailureMessage(hasTurn: boolean, sawRelay: boolean): string {
  if (!hasTurn) {
    return "Could not connect. Calls between two different networks usually need a TURN relay, which is not configured.";
  }
  if (!sawRelay) {
    return "Could not connect — the relay server did not respond. Check the TURN settings.";
  }
  return "The connection dropped.";
}

function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera and microphone access was blocked. Allow it in your browser's site settings and reload.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera or microphone was found on this device.";
    case "NotReadableError":
    case "TrackStartError":
      return "Your camera is already in use by another app. Close it and try again.";
    case "OverconstrainedError":
      return "Your camera does not support the requested video settings.";
    default:
      return "Could not start the camera. Check that this page is served over HTTPS.";
  }
}

export interface CallState {
  phase: CallPhase;
  partner: PartnerProfile | null;
  roomId: string | null;
  messages: ChatMessage[];
  queuePosition: number;
  queueSize: number;
  onlineCount: number;
  error: string | null;
  partnerTyping: boolean;
  isMuted: boolean;
  isCameraOff: boolean;
  hasTurn: boolean;
  waitedMs: number;
  /**
   * Filters the server refused to apply, because they are premium-only.
   *
   * Not an error: the search went ahead, just without them. Reporting it as a
   * failure would stop a free user from matching at all, and saying nothing
   * would leave them watching strangers arrive from every country they thought
   * they had excluded.
   */
  restrictedFilters: Array<"gender" | "country">;
}

export function useCall() {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [partner, setPartner] = useState<PartnerProfile | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [queuePosition, setQueuePosition] = useState(0);
  const [queueSize, setQueueSize] = useState(0);
  const [onlineCount, setOnlineCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [restrictedFilters, setRestrictedFilters] = useState<Array<"gender" | "country">>([]);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [hasTurn, setHasTurn] = useState(false);
  /*
   * The connection-state handler needs the *current* value, not the one
   * captured when createPeer was built — createPeer sets it moments earlier,
   * so a closure over the state would always report the previous value and
   * blame the wrong thing when a call fails.
   */
  const hasTurnRef = useRef(false);
  /** Did ICE ever produce a relay candidate? The real test of whether TURN works. */
  const sawRelayRef = useRef(false);
  const [waitedMs, setWaitedMs] = useState(0);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<string | null>(null);
  /**
   * ICE candidates can arrive before the remote description is set, and
   * addIceCandidate throws if it does. Buffer them until the answer lands.
   */
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set while intentionally leaving, so teardown does not look like a drop. */
  const leavingRef = useRef(false);

  // --- Camera ------------------------------------------------------------

  const startCamera = useCallback(async (): Promise<MediaStream | null> => {
    if (localStreamRef.current) return localStreamRef.current;
    setPhase("requesting-camera");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setPhase("idle");
      return stream;
    } catch (err) {
      setPhase("camera-denied");
      setError(cameraErrorMessage(err));
      return null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  // --- Peer connection ---------------------------------------------------

  /*
   * An offer that arrived before there was anything to answer it with.
   *
   * createPeer fetches ICE servers before it can build the connection, and
   * that fetch is a round trip to the API — over a tunnel, not a fast one.
   * Both sides start it the instant they are matched, so the initiator
   * routinely finishes first and its offer lands while the other side is
   * still waiting on the same request, with peerRef.current still null.
   *
   * ICE candidates were already buffered for exactly this reason. The offer
   * was not: it was dropped, no answer was ever sent, and both people sat
   * looking at a connection that never carried anything. Same treatment.
   */
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null);

  const teardownPeer = useCallback(() => {
    const peer = peerRef.current;
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.close();
    }
    peerRef.current = null;
    pendingCandidates.current = [];
    pendingOffer.current = null;
    setRemoteStream(null);
  }, []);

  /**
   * Answer an offer: apply it, flush anything that arrived early, reply.
   *
   * Shared because there are two moments it can happen — when the offer
   * arrives and the connection is ready, or when the connection becomes ready
   * and the offer is already waiting.
   */
  const answerOffer = useCallback(
    async (peer: RTCPeerConnection, offer: RTCSessionDescriptionInit, room: string | null) => {
      await peer.setRemoteDescription(new RTCSessionDescription(offer));

      for (const candidate of pendingCandidates.current) {
        await peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
      pendingCandidates.current = [];

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      getSocket().emit("answer", { roomId: room, answer });
    },
    [],
  );

  const createPeer = useCallback(async (room: string, initiator: boolean) => {
    let ice: RTCIceServer[] = FALLBACK_ICE;
    try {
      const { data } = await api.get<IceConfig>("/rtc/ice-servers");
      ice = data.iceServers?.length ? data.iceServers : FALLBACK_ICE;
      setHasTurn(Boolean(data.hasTurn));
      hasTurnRef.current = Boolean(data.hasTurn);
    } catch {
      // A failed ICE fetch still allows same-network calls via STUN.
      setHasTurn(false);
      hasTurnRef.current = false;
    }
    sawRelayRef.current = false;

    const socket = getSocket();
    const peer = new RTCPeerConnection({ iceServers: ice, iceCandidatePoolSize: 4 });
    peerRef.current = peer;

    localStreamRef.current?.getTracks().forEach((track) => {
      peer.addTrack(track, localStreamRef.current!);
    });

    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      // A relay candidate is proof the TURN server actually answered; its
      // absence is why cross-network calls fail.
      if (event.candidate.candidate?.includes(" typ relay")) {
        sawRelayRef.current = true;
      }
      socket.emit("ice-candidate", { roomId: room, candidate: event.candidate });
    };

    peer.ontrack = (event) => {
      /*
       * A track object, not a picture.
       *
       * ontrack fires as soon as the remote description is applied and a
       * transceiver exists — before ICE has connected and long before any
       * frame arrives. Calling that "live" is what produced the report this
       * comment exists for: the header said LIVE, the partner's name appeared
       * over their tile, and the tile stayed black forever because the two
       * networks never managed to connect.
       *
       * Keep the stream; let the connection state decide when it is live.
       */
      setRemoteStream(event.streams[0]);
    };

    /*
     * Two listeners for one question, because browsers disagree about which
     * one to answer it with. connectionState is the modern signal; Safari has
     * historically only moved iceConnectionState. Missing both would leave a
     * working call stuck on "Connecting".
     */
    peer.oniceconnectionstatechange = () => {
      const state = peer.iceConnectionState;
      if (state === "connected" || state === "completed") setPhase("live");
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === "connected") setPhase("live");
      // "failed" almost always means no relay was available for this pair.
      if (state === "failed") {
        setError(connectionFailureMessage(hasTurnRef.current, sawRelayRef.current));
        setPhase("partner-lost");
      }
    };

    if (initiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit("offer", { roomId: room, offer });
    } else if (pendingOffer.current) {
      // It arrived while the ICE fetch was still in flight.
      const waiting = pendingOffer.current;
      pendingOffer.current = null;
      await answerOffer(peer, waiting, room);
    }

    return peer;
    // Deliberately no `hasTurn` dependency: the handler reads the ref, so
    // rebuilding this callback on every change would only churn the socket
    // listeners that depend on it.
  }, [answerOffer]);

  // --- Socket wiring -----------------------------------------------------

  useEffect(() => {
    const socket = getSocket();

    const onConnected = (data: { onlineCount: number }) => {
      setOnlineCount(data.onlineCount ?? 0);
    };

    const onQueueJoined = (data: QueueJoined) => {
      setQueuePosition(data.position);
      setQueueSize(data.size);
      setPhase("queued");
      setError(null);
    };

    const onQueueStatus = (data: { position: number; size: number; online: number }) => {
      setQueuePosition(data.position);
      setQueueSize(data.size);
      setOnlineCount(data.online);
    };

    const onQueueError = (data: QueueError) => {
      setError(data.message);
      setPhase("idle");
    };

    const onFiltersRestricted = (data: { dropped?: Array<"gender" | "country"> }) => {
      setRestrictedFilters(Array.isArray(data?.dropped) ? data.dropped : []);
    };

    const onQueueRequeued = (data: { position: number }) => {
      setQueuePosition(data.position);
      setPhase("queued");
    };

    const onMatchFound = async (data: MatchFound) => {
      roomRef.current = data.roomId;
      setRoomId(data.roomId);
      setPartner(data.partner);
      setMessages([]);
      setWaitedMs(data.waitedMs);
      setPhase("connecting");
      setError(null);
      leavingRef.current = false;
      await createPeer(data.roomId, data.isInitiator);
    };

    const onOffer = async ({ offer }: { offer: RTCSessionDescriptionInit }) => {
      const peer = peerRef.current;
      if (!peer) {
        // createPeer is still fetching ICE servers. Keep it; createPeer picks
        // it up as soon as the connection exists. Dropping it here is what
        // left both people staring at a call that never started.
        pendingOffer.current = offer;
        return;
      }
      await answerOffer(peer, offer, roomRef.current);
    };

    const onAnswer = async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      const peer = peerRef.current;
      if (!peer || peer.signalingState === "stable") return;
      await peer.setRemoteDescription(new RTCSessionDescription(answer));

      for (const candidate of pendingCandidates.current) {
        await peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
      pendingCandidates.current = [];
    };

    const onIceCandidate = async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      const peer = peerRef.current;
      if (!peer || !candidate) return;
      if (!peer.remoteDescription) {
        pendingCandidates.current.push(candidate);
        return;
      }
      await peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    };

    const onChatMessage = (message: ChatMessage) => {
      setMessages((prev) => [...prev, message]);
      setPartnerTyping(false);
    };

    const onTyping = ({ isTyping }: { isTyping: boolean }) => {
      setPartnerTyping(isTyping);
    };

    const onPartnerLeft = ({ reason }: { reason: string }) => {
      teardownPeer();
      setPhase("ended");
      setPartner(null);
      roomRef.current = null;
      setRoomId(null);
      setError(reason === "timeout" ? "The chat timed out." : null);
    };

    const onPartnerConnectionLost = ({ graceMs }: { graceMs: number }) => {
      setPhase("partner-lost");
      setError(`Reconnecting… (${Math.round(graceMs / 1000)}s)`);
    };

    const onPartnerReconnected = () => {
      setPhase("live");
      setError(null);
    };

    const onChatEnded = () => {
      teardownPeer();
      setPhase(leavingRef.current ? "idle" : "ended");
      setPartner(null);
      roomRef.current = null;
      setRoomId(null);
    };

    const onSessionReplaced = () => {
      setError("You signed in somewhere else.");
      setPhase("ended");
    };

    socket.on("connected", onConnected);
    socket.on("queue-joined", onQueueJoined);
    socket.on("queue-status", onQueueStatus);
    socket.on("queue-error", onQueueError);
    socket.on("filters-restricted", onFiltersRestricted);
    socket.on("queue-requeued", onQueueRequeued);
    socket.on("match-found", onMatchFound);
    socket.on("offer", onOffer);
    socket.on("answer", onAnswer);
    socket.on("ice-candidate", onIceCandidate);
    socket.on("chat-message", onChatMessage);
    socket.on("typing", onTyping);
    socket.on("partner-left", onPartnerLeft);
    socket.on("partner-connection-lost", onPartnerConnectionLost);
    socket.on("partner-reconnected", onPartnerReconnected);
    socket.on("chat-ended", onChatEnded);
    socket.on("session-replaced", onSessionReplaced);

    return () => {
      socket.off("connected", onConnected);
      socket.off("queue-joined", onQueueJoined);
      socket.off("queue-status", onQueueStatus);
      socket.off("queue-error", onQueueError);
      socket.off("filters-restricted", onFiltersRestricted);
      socket.off("queue-requeued", onQueueRequeued);
      socket.off("match-found", onMatchFound);
      socket.off("offer", onOffer);
      socket.off("answer", onAnswer);
      socket.off("ice-candidate", onIceCandidate);
      socket.off("chat-message", onChatMessage);
      socket.off("typing", onTyping);
      socket.off("partner-left", onPartnerLeft);
      socket.off("partner-connection-lost", onPartnerConnectionLost);
      socket.off("partner-reconnected", onPartnerReconnected);
      socket.off("chat-ended", onChatEnded);
      socket.off("session-replaced", onSessionReplaced);
    };
  }, [createPeer, teardownPeer, answerOffer]);

  // Poll queue position while waiting, so the UI is not frozen on a stale number.
  useEffect(() => {
    if (phase !== "queued") return;
    const socket = getSocket();
    const timer = setInterval(() => socket.emit("queue-status"), 3000);
    return () => clearInterval(timer);
  }, [phase]);

  // --- Actions -----------------------------------------------------------

  const start = useCallback(
    async (filters: MatchFilters) => {
      const stream = await startCamera();
      if (!stream) return;
      setError(null);
      /*
       * Cleared before every join, and set again only if the server says so.
       *
       * The notice is about the join that is happening now. Left standing, it
       * outlives the thing it described: someone who buys a pass and comes
       * back still sees "choosing a gender is premium" over a search that is,
       * this time, actually filtering — and the bar that would have told them
       * so is hidden behind it.
       */
      setRestrictedFilters([]);
      getSocket().emit("join-queue", filters);
    },
    [startCamera],
  );

  const cancelQueue = useCallback(() => {
    getSocket().emit("leave-queue");
    setPhase("idle");
  }, []);

  const skip = useCallback(
    (filters: MatchFilters) => {
      const room = roomRef.current;
      leavingRef.current = true;
      teardownPeer();
      if (room) getSocket().emit("skip", { roomId: room });
      roomRef.current = null;
      setRoomId(null);
      setPartner(null);
      setMessages([]);
      // Straight back into the queue: that is what "next" means here.
      setRestrictedFilters([]);
      getSocket().emit("join-queue", filters);
    },
    [teardownPeer],
  );

  const endChat = useCallback(() => {
    const room = roomRef.current;
    leavingRef.current = true;
    teardownPeer();
    if (room) getSocket().emit("end-chat", { roomId: room });
    roomRef.current = null;
    setRoomId(null);
    setPartner(null);
    setPhase("idle");
  }, [teardownPeer]);

  const sendMessage = useCallback((text: string) => {
    const room = roomRef.current;
    if (!room || !text.trim()) return;
    getSocket().emit("chat-message", { roomId: room, text });
  }, []);

  const setTyping = useCallback((isTyping: boolean) => {
    const room = roomRef.current;
    if (!room) return;
    getSocket().emit("typing", { roomId: room, isTyping });
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (isTyping) {
      typingTimer.current = setTimeout(() => {
        getSocket().emit("typing", { roomId: room, isTyping: false });
      }, 2500);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !isMuted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setIsMuted(next);
  }, [isMuted]);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !isCameraOff;
    stream.getVideoTracks().forEach((t) => (t.enabled = !next));
    setIsCameraOff(next);
  }, [isCameraOff]);

  // Release the camera and any live peer when the screen unmounts, so the
  // hardware light does not stay on after navigating away.
  useEffect(() => {
    return () => {
      teardownPeer();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [teardownPeer]);

  return {
    state: {
      phase,
      partner,
      roomId,
      messages,
      queuePosition,
      queueSize,
      onlineCount,
      error,
      partnerTyping,
      isMuted,
      isCameraOff,
      hasTurn,
      waitedMs,
      restrictedFilters,
    } as CallState,
    localStream,
    remoteStream,
    startCamera,
    stopCamera,
    start,
    cancelQueue,
    skip,
    endChat,
    sendMessage,
    setTyping,
    toggleMute,
    toggleCamera,
    clearError: () => setError(null),
  };
}
