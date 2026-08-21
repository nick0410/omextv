import { create } from "zustand";

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

interface ChatState {
  roomId: string | null;
  partnerId: string | null;
  partnerUsername: string | null;
  isInitiator: boolean;
  messages: ChatMessage[];
  isMatching: boolean;
  isConnected: boolean;
  isMuted: boolean;
  isCameraOff: boolean;

  setRoom: (roomId: string, partnerId: string, partnerUsername: string, isInitiator: boolean) => void;
  addMessage: (message: ChatMessage) => void;
  setMatching: (matching: boolean) => void;
  setConnected: (connected: boolean) => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  resetChat: () => void;
}

export const useChatStore = create<ChatState>()((set) => ({
  roomId: null,
  partnerId: null,
  partnerUsername: null,
  isInitiator: false,
  messages: [],
  isMatching: false,
  isConnected: false,
  isMuted: false,
  isCameraOff: false,

  setRoom: (roomId, partnerId, partnerUsername, isInitiator) =>
    set({ roomId, partnerId, partnerUsername, isInitiator, messages: [], isConnected: true, isMatching: false }),

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  setMatching: (matching) => set({ isMatching: matching }),

  setConnected: (connected) => set({ isConnected: connected }),

  toggleMute: () => set((state) => ({ isMuted: !state.isMuted })),

  toggleCamera: () => set((state) => ({ isCameraOff: !state.isCameraOff })),

  resetChat: () =>
    set({
      roomId: null,
      partnerId: null,
      partnerUsername: null,
      isInitiator: false,
      messages: [],
      isMatching: false,
      isConnected: false,
    }),
}));
