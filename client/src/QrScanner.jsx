import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

export default function QrScanner({ onDecoded, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(document.createElement('canvas'));
  const [error, setError] = useState(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        tick();
      } catch (err) {
        setError(err.message || 'Could not access camera');
      }
    }

    function tick() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code) {
          stop();
          onDecoded(code.data);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    function stop() {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    }

    start();

    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="qr-scanner">
      {error ? (
        <p className="error">Camera error: {error}</p>
      ) : (
        <video ref={videoRef} playsInline muted className="qr-video" />
      )}
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}
