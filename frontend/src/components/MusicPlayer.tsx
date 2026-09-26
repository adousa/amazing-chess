import { useEffect, useRef } from 'react';

// Background music that plays while the game plays (autoplay or live) and pauses with it,
// through YouTube's official embedded player (IFrame Player API). The track is streamed from its
// official upload, never downloaded, and the player stays visible as YouTube's rules require.

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  setVolume(v: number): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width: number;
      height: number;
      playerVars: Record<string, string | number>;
      events: { onReady: () => void };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;
function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise)
    apiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(window.YT!);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  return apiPromise;
}

export interface MusicPlayerProps {
  videoId: string;
  /** Play while true (autoplay or a live game), pause otherwise. */
  playing: boolean;
  title: string;
  credit: string;
}

export function MusicPlayer({ videoId, playing, title, credit }: MusicPlayerProps) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const ready = useRef(false);
  const want = useRef(playing);
  want.current = playing;

  useEffect(() => {
    let dead = false;
    loadApi().then((YT) => {
      if (dead || !host.current) return;
      const el = document.createElement('div');
      host.current.appendChild(el);
      player.current = new YT.Player(el, {
        videoId,
        width: 200,
        height: 200,
        playerVars: { loop: 1, playlist: videoId, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => {
            ready.current = true;
            player.current?.setVolume(45);
            if (want.current) player.current?.playVideo();
          },
        },
      });
    });
    return () => {
      dead = true;
      ready.current = false;
      player.current?.destroy();
      player.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    if (!ready.current || !player.current) return;
    if (playing) player.current.playVideo();
    else player.current.pauseVideo();
  }, [playing]);

  return (
    <div className="music">
      <div className="music-player" ref={host} />
      <div className="music-caption">
        <span className="music-title">♪ {title}</span>
        <span className="muted small">{credit}</span>
      </div>
    </div>
  );
}
