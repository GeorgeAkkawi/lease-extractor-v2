import { useCallback, useEffect, useRef, useState } from 'react';

// Capture a signature as a PNG. Two ways in, because both are what people actually do:
//
//   ✎ Draw  — a finger on a phone or a trackpad, which is what a tenant reaches for.
//   ⌨ Type  — the name rendered in a script face, which is what a landlord signing at a
//             desk with a mouse reaches for. Legally identical: ESIGN/UETA care about the
//             deliberate act and the record of it, not the shape of the mark.
//
// Both produce the SAME artifact — a PNG data URL — so nothing downstream (the edge
// function's validation, the executed PDF's embedPng) has to know which was used.
//
// The canvas is drawn at 2× and displayed at 1× so the signature isn't a soft mess on the
// certificate page, which is the one place it will be looked at closely.
const SCALE = 2;
const W = 460;
const H = 150;

export default function SignaturePad({ value, onChange, typedName = '', disabled = false }) {
  const [mode, setMode] = useState('draw');
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const drew = useRef(false);
  const last = useRef(null);

  // Re-emit whenever the canvas has something on it. Kept in a ref-guarded callback so a
  // parent re-render can't wipe a half-drawn signature.
  const emit = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    onChange(drew.current ? c.toDataURL('image/png') : '');
  }, [onChange]);

  const clear = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    drew.current = false;
    onChange('');
  }, [onChange]);

  // Typed mode renders the name into the same canvas, so switching modes doesn't change
  // what the signature IS — only how it got there.
  useEffect(() => {
    if (mode !== 'type') return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const name = (typedName || '').trim();
    if (!name) { drew.current = false; onChange(''); return; }
    ctx.fillStyle = '#111';
    // Shrink to fit rather than overflow — a long business name must still land inside
    // the box on the certificate.
    let size = 46 * SCALE;
    do {
      ctx.font = `italic ${size}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`;
      size -= 2 * SCALE;
    } while (ctx.measureText(name).width > c.width - 40 * SCALE && size > 16 * SCALE);
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 20 * SCALE, c.height / 2);
    drew.current = true;
    onChange(c.toDataURL('image/png'));
  }, [mode, typedName, onChange]);

  // Pointer events cover mouse, trackpad, finger and stylus in one path — a touch-only
  // implementation would leave a landlord at a desk unable to sign at all.
  const pos = (e) => {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  };

  const start = (e) => {
    if (disabled || mode !== 'draw') return;
    e.preventDefault();
    drawing.current = true;
    last.current = pos(e);
    canvasRef.current.setPointerCapture?.(e.pointerId);
  };

  const move = (e) => {
    if (!drawing.current || mode !== 'draw') return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pos(e);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2.4 * SCALE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    drew.current = true;
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    emit();
  };

  return (
    <div className="sigpad">
      <div className="sigpad-head">
        <span className="sigpad-label">Sign here</span>
        <div className="seg">
          <button type="button" className={`seg-btn${mode === 'draw' ? ' on' : ''}`}
            onClick={() => { setMode('draw'); clear(); }} disabled={disabled}>✎ Draw</button>
          <button type="button" className={`seg-btn${mode === 'type' ? ' on' : ''}`}
            onClick={() => setMode('type')} disabled={disabled}>⌨ Type</button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className={`sigpad-canvas${mode === 'type' ? ' typed' : ''}`}
        width={W * SCALE}
        height={H * SCALE}
        style={{ width: '100%', maxWidth: W, height: H }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        aria-label="Signature"
      />
      <div className="sigpad-foot">
        <span className="muted">
          {mode === 'draw'
            ? 'Draw your signature with a finger, stylus or mouse.'
            : typedName.trim()
              ? 'Your typed name is your signature.'
              : 'Type your name above and it will appear here.'}
        </span>
        {mode === 'draw' && value && (
          <button type="button" className="ghost btn-sm" onClick={clear} disabled={disabled}>Clear</button>
        )}
      </div>
    </div>
  );
}
