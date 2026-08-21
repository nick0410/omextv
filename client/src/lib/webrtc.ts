import api from "./axios";

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export async function getIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await api.get("/rtc/ice-servers");
    return res.data.iceServers;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

export function createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: iceServers as RTCIceServer[],
    iceCandidatePoolSize: 10,
  });
}
