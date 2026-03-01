import { useState, useRef, useEffect, useCallback } from "react";

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function lerp(a, b, t) { return a + (b - a) * t; }

function applyDuotone(imageData, darkColor, lightColor) {
  const [dr, dg, db] = hexToRgb(darkColor);
  const [lr, lg, lb] = hexToRgb(lightColor);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    data[i]     = lerp(dr, lr, gray);
    data[i + 1] = lerp(dg, lg, gray);
    data[i + 2] = lerp(db, lb, gray);
  }
  return imageData;
}

function applyHalftone(duoCtx, w, h, dotSize) {
  const imgData = duoCtx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const step = dotSize * 2;
  const dotCanvas = document.createElement("canvas");
  dotCanvas.width = w; dotCanvas.height = h;
  const dc = dotCanvas.getContext("2d");
  dc.putImageData(imgData, 0, 0);
  dc.globalCompositeOperation = "source-in";
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      let total = 0, count = 0;
      for (let dy = 0; dy < step && y + dy < h; dy++) {
        for (let dx = 0; dx < step && x + dx < w; dx++) {
          const idx = ((y + dy) * w + (x + dx)) * 4;
          if (data[idx + 3] > 0) {
            total += (0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2]) / 255;
            count++;
          }
        }
      }
      if (count === 0) continue;
      const r = (total / count) * dotSize * 0.95;
      if (r < 0.3) continue;
      const cx = Math.min(x + dotSize, w - 1);
      const cy = Math.min(y + dotSize, h - 1);
      const idx = (cy * w + cx) * 4;
      dc.beginPath();
      dc.arc(x + dotSize, y + dotSize, r, 0, Math.PI * 2);
      dc.fillStyle = `rgba(${data[idx]},${data[idx+1]},${data[idx+2]},${data[idx+3]/255})`;
      dc.fill();
    }
  }
  return dotCanvas;
}

function createOutlineCanvas(img, strokeWidth, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.shadowColor = "white";
  ctx.shadowBlur = strokeWidth * 1.5;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    ctx.save();
    ctx.shadowOffsetX = Math.cos(a) * strokeWidth;
    ctx.shadowOffsetY = Math.sin(a) * strokeWidth;
    ctx.drawImage(img, 0, 0, w, h);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function deriveDuotone(bgHex) {
  const [r, g, b] = hexToRgb(bgHex);
  const dark = `#${Math.round(r*0.15).toString(16).padStart(2,"0")}${Math.round(g*0.15).toString(16).padStart(2,"0")}${Math.round(b*0.15).toString(16).padStart(2,"0")}`;
  return { dark, light: "#F5EDD8" };
}

const PREVIEW_COLORS = [
  { label: "Teal", value: "#1E4D4A" },
  { label: "Purple", value: "#5B2D6E" },
  { label: "Lime", value: "#7AB330" },
  { label: "Rust", value: "#C4622D" },
  { label: "Slate", value: "#3D5A6B" },
  { label: "Magenta", value: "#C4306A" },
];

export default function PortraitEffectTool() {
  const [image, setImage] = useState(null);
  const [strokeWidth, setStrokeWidth] = useState(12);
  const [dotSize, setDotSize] = useState(4);
  const [previewBg, setPreviewBg] = useState("#1E4D4A");
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const canvasRef = useRef(null);
  const outputRef = useRef(null);
  const imgRef = useRef(null);

  const handleUpload = useCallback((e) => {
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { imgRef.current = img; setImage(url); setDone(false); };
    img.src = url;
  }, []);

  const process = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    setProcessing(true);
    requestAnimationFrame(() => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;

      // duotone based on preview color
      const duoCanvas = document.createElement("canvas");
      duoCanvas.width = W; duoCanvas.height = H;
      const duoCtx = duoCanvas.getContext("2d");
      duoCtx.drawImage(img, 0, 0, W, H);
      const dt = deriveDuotone(previewBg);
      const imgData = duoCtx.getImageData(0, 0, W, H);
      applyDuotone(imgData, dt.dark, dt.light);
      duoCtx.putImageData(imgData, 0, 0);

      // halftone
      const dotCanvas = applyHalftone(duoCtx, W, H, dotSize);

      // transparent output: outline + halftone subject, NO bg
      const out = document.createElement("canvas");
      out.width = W; out.height = H;
      const outCtx = out.getContext("2d");
      outCtx.drawImage(createOutlineCanvas(img, strokeWidth, W, H), 0, 0);
      outCtx.drawImage(dotCanvas, 0, 0);
      outputRef.current = out;

      // preview with bg
      const preview = canvasRef.current;
      if (preview) {
        preview.width = W; preview.height = H;
        const pCtx = preview.getContext("2d");
        pCtx.fillStyle = previewBg;
        pCtx.fillRect(0, 0, W, H);
        pCtx.drawImage(out, 0, 0);
      }

      setProcessing(false);
      setDone(true);
    });
  }, [previewBg, strokeWidth, dotSize]);

  const download = (format) => {
    const canvas = outputRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `portrait.${format}`;
    link.href = canvas.toDataURL(format === "webp" ? "image/webp" : "image/png", 0.95);
    link.click();
  };

  useEffect(() => { if (imgRef.current) process(); }, [previewBg, strokeWidth, dotSize]);

  return (
    <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", background: "#F5F0E8", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header style={{ background: "#1A1A1A", color: "white", padding: "14px 28px", display: "flex", alignItems: "center", gap: "12px" }}>
        <span style={{ fontSize: "19px", fontWeight: 700, letterSpacing: "-0.5px" }}>MarcoToday</span>
        <span style={{ background: "#5B2D6E", color: "white", fontSize: "10px", fontWeight: 700, padding: "3px 8px", borderRadius: "4px", textTransform: "uppercase", letterSpacing: "0.8px" }}>Portrait Tool</span>
        <span style={{ marginLeft: "auto", fontSize: "11px", color: "#666" }}>Output = transparant — achtergrond via Webflow CMS</span>
      </header>

      <main style={{ flex: 1, display: "flex", maxWidth: "1100px", margin: "0 auto", width: "100%", padding: "32px 24px", gap: "40px" }}>
        {/* Controls */}
        <aside style={{ width: "256px", flexShrink: 0 }}>

          {/* Upload */}
          <SectionLabel>Afbeelding</SectionLabel>
          <label
            htmlFor="fileInput"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleUpload}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              border: `2px dashed ${image ? "#5B2D6E" : "#C8C0B8"}`, borderRadius: "10px",
              padding: "20px 12px", cursor: "pointer", background: image ? "#F0E8F8" : "white",
              textAlign: "center", transition: "all 0.2s", marginBottom: "24px",
            }}
          >
            <input id="fileInput" type="file" accept="image/png,image/webp" onChange={handleUpload} style={{ display: "none" }} aria-label="Upload portret PNG" />
            <div style={{ fontSize: "24px", marginBottom: "6px" }}>{image ? "🔄" : "⬆️"}</div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "#333" }}>{image ? "Ander bestand" : "Upload PNG (transparant)"}</div>
            <div style={{ fontSize: "11px", color: "#999", marginTop: "3px" }}>of sleep hier naartoe</div>
          </label>

          {/* Stroke */}
          <SectionLabel>Witte rand</SectionLabel>
          <RangeControl label="Dikte" value={strokeWidth} min={4} max={50} onChange={setStrokeWidth} unit="px" />
          <div style={{ marginBottom: "24px" }} />

          {/* Halftone */}
          <SectionLabel>Halftone raster</SectionLabel>
          <RangeControl label="Dot grootte" value={dotSize} min={2} max={12} onChange={setDotSize} unit="px" />
          <div style={{ marginBottom: "24px" }} />

          {/* Preview color */}
          <SectionLabel>Voorbeeldkleur</SectionLabel>
          <p style={{ fontSize: "11px", color: "#888", margin: "0 0 10px 0", lineHeight: 1.4 }}>
            Alleen voor preview — kleur bepaalt ook de duotone tint.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "24px" }}>
            {PREVIEW_COLORS.map((p) => (
              <button
                key={p.value}
                title={p.label}
                aria-label={`Preview: ${p.label}`}
                aria-pressed={previewBg === p.value}
                onClick={() => setPreviewBg(p.value)}
                style={{
                  width: "28px", height: "28px", borderRadius: "6px", background: p.value, cursor: "pointer",
                  border: previewBg === p.value ? "3px solid #1A1A1A" : "2px solid rgba(0,0,0,0.1)",
                  outline: previewBg === p.value ? "2px solid white" : "none",
                  outlineOffset: "-4px", transition: "transform 0.1s",
                }}
                onMouseEnter={(e) => e.currentTarget.style.transform = "scale(1.15)"}
                onMouseLeave={(e) => e.currentTarget.style.transform = "scale(1)"}
              />
            ))}
            <input type="color" value={previewBg} onChange={(e) => setPreviewBg(e.target.value)}
              style={{ width: "28px", height: "28px", padding: 0, border: "none", borderRadius: "6px", cursor: "pointer" }}
              aria-label="Aangepaste kleur" title="Aangepaste kleur" />
          </div>

          {/* Download */}
          {done && (
            <div style={{ display: "flex", gap: "8px" }}>
              <DownloadBtn label="↓ PNG" onClick={() => download("png")} primary />
              <DownloadBtn label="↓ WebP" onClick={() => download("webp")} />
            </div>
          )}

          <div style={{ marginTop: "20px", padding: "12px", background: "white", borderRadius: "8px", fontSize: "11px", color: "#777", lineHeight: 1.6, border: "1px solid #E8E3DA" }}>
            <strong style={{ color: "#333" }}>📌 Transparant bestand</strong><br />
            De download bevat geen achtergrond — alleen persoon + witte rand + halftone. Webflow plaatst het op de CMS-kleur.
          </div>
        </aside>

        {/* Preview */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel>Preview</SectionLabel>
          <div style={{
            background: image ? previewBg : "#E8E3DA",
            borderRadius: "14px",
            minHeight: "500px",
            display: "flex", alignItems: "center", justifyContent: "center",
            position: "relative", overflow: "hidden",
            transition: "background 0.3s",
            boxShadow: "0 2px 20px rgba(0,0,0,0.08)",
          }}>
            {!image && (
              <div style={{ textAlign: "center", color: "rgba(0,0,0,0.2)" }}>
                <div style={{ fontSize: "52px", marginBottom: "10px" }}>👤</div>
                <div style={{ fontSize: "14px" }}>Upload een portret om te starten</div>
              </div>
            )}
            {processing && (
              <div style={{
                position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)",
                display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 10, fontSize: "14px", color: "white", fontWeight: 600, gap: "8px",
              }}>
                <SpinIcon /> Verwerken...
              </div>
            )}
            <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "620px", display: image ? "block" : "none" }} aria-label="Verwerkt portret preview" />
          </div>

          {done && (
            <div style={{
              marginTop: "10px", padding: "10px 14px", background: "white", borderRadius: "8px",
              fontSize: "12px", color: "#555", display: "flex", gap: "16px", flexWrap: "wrap",
              border: "1px solid #E8E3DA",
            }}>
              <span>✅ Klaar voor download</span>
              <span>Rand: <strong>{strokeWidth}px</strong></span>
              <span>Halftone: <strong>{dotSize}px</strong></span>
              <span style={{ marginLeft: "auto", color: "#999" }}>Output is transparant</span>
            </div>
          )}
        </div>
      </main>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}

function SectionLabel({ children }) {
  return <div style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.8px", color: "#888", marginBottom: "10px" }}>{children}</div>;
}

function RangeControl({ label, value, min, max, onChange, unit }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
        <span style={{ fontSize: "12px", color: "#555" }}>{label}</span>
        <span style={{ fontSize: "12px", fontFamily: "monospace", color: "#5B2D6E", fontWeight: 700 }}>{value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", accentColor: "#5B2D6E" }} aria-label={label} />
    </div>
  );
}

function DownloadBtn({ label, onClick, primary }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, background: primary ? "#1A1A1A" : "white", color: primary ? "white" : "#1A1A1A",
        border: primary ? "none" : "1.5px solid #CCC", borderRadius: "8px",
        padding: "12px 8px", fontSize: "13px", fontWeight: 600, cursor: "pointer",
      }}
      onMouseEnter={(e) => e.currentTarget.style.opacity = "0.8"}
      onMouseLeave={(e) => e.currentTarget.style.opacity = "1"}
    >
      {label}
    </button>
  );
}

function SpinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 0.8s linear infinite" }}>
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}
