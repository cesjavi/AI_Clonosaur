import { useEffect } from "react";
import "./Splash.css";

interface Props {
  onFinish: () => void;
}

/// Brief branded screen within the same window (avoids the complexity
/// of a second native Tauri window). It's shown briefly when the app
/// opens and then transitions on its own to the main screen.
export default function Splash({ onFinish }: Props) {
  useEffect(() => {
    const t = setTimeout(onFinish, 1100);
    return () => clearTimeout(t);
  }, [onFinish]);

  return (
    <div className="splash" onClick={onFinish}>
      <div className="splash-logo">🦕</div>
      <h1>Clonosaur</h1>
      <p>Tu clon, en tu computadora.</p>
    </div>
  );
}
