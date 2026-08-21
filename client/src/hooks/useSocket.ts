import { useEffect, useRef, useCallback, useState } from "react";
import { Socket } from "socket.io-client";
import { getSocket, disconnectSocket } from "../lib/socket";
import { useAuthStore } from "../store/authStore";

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) return;

    const socket = getSocket();
    socketRef.current = socket;

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    if (socket.connected) setIsConnected(true);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [token]);

  const disconnect = useCallback(() => {
    disconnectSocket();
    socketRef.current = null;
    setIsConnected(false);
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    disconnect,
  };
}
