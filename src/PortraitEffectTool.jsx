import { useState, useRef, useEffect } from "react";
import { removeBackground } from "@imgly/background-removal";

/* ── Constants ───────────────────────────────────── */

const OUTLINE_COLOR = "#F7F6E9";

const PREVIEW_COLORS = [
  { label: "Teal", value: "#1E4D4A" },
  { label: "Purple", value: "#5B2D6E" },
  { label: "Lime", value: "#7AB330" },
  { label: "Rust", value: "#C4622D" },
  { label: "Slate", value: "#3D5A6B" },
  { label: "Magenta", value: "#C4306A" },
];

/* ── Helpers ──────────────────────────────────────── */

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function deriveDuotone(bgHex, inkDarkness) {
  // inkDarkness: 0 = same as bg, 100 = pure black
  // Blends between the bg color and black based on the slider
  const [r, g, b] = hexToRgb(bgHex);
  const factor = 1 - inkDarkness / 100;
  const dark =
    "#" +
    [r, g, b]
      .map((c) =>
        Math.round(c * factor)
          .toString(16)
          .padStart(2, "0")
      )
      .join("");
  return { dark, light: OUTLINE_COLOR };
}

/** Check if image has >5% transparent pixels */
function hasTransparency(img) {
  const scale = Math.min(200 / img.naturalWidth, 200 / img.naturalHeight, 1);
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) transparent++;
  }
  return transparent / (data.length / 4) > 0.05;
}

/**
 * CRISP solid outline — clean, smooth, even border.
 *
 * Step 1: Hard alpha mask with higher threshold (128) to reject noisy
 *         semi-transparent pixels from bg removal. Then erode by 1px
 *         to clean up jagged edges before dilating.
 * Step 2: Dilate the clean mask outward by strokeWidth.
 * Step 3: Fill dilated area with OUTLINE_COLOR, cut out the original.
 */
function createOutline(img, strokeWidth, w, h) {
  // --- Step 1: Hard alpha mask ---
  const mask = document.createElement("canvas");
  mask.width = w;
  mask.height = h;
  const mCtx = mask.getContext("2d");
  mCtx.drawImage(img, 0, 0, w, h);
  const mData = mCtx.getImageData(0, 0, w, h);
  const px = mData.data;

  // Higher threshold to reject noisy edge pixels from bg removal
  for (let i = 3; i < px.length; i += 4) {
    px[i] = px[i] > 128 ? 255 : 0;
  }

  // Erode by 1px: a pixel is only kept if ALL 4 neighbors are also solid.
  // This removes single-pixel noise and smooths jagged edges.
  const eroded = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      if (
        px[idx + 3] === 255 &&
        px[((y - 1) * w + x) * 4 + 3] === 255 &&
        px[((y + 1) * w + x) * 4 + 3] === 255 &&
        px[(y * w + x - 1) * 4 + 3] === 255 &&
        px[(y * w + x + 1) * 4 + 3] === 255
      ) {
        eroded[y * w + x] = 1;
      }
    }
  }

  // Write eroded mask back
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (eroded[y * w + x]) {
        px[idx] = px[idx + 1] = px[idx + 2] = 255;
        px[idx + 3] = 255;
      } else {
        px[idx] = px[idx + 1] = px[idx + 2] = 0;
        px[idx + 3] = 0;
      }
    }
  }
  mCtx.putImageData(mData, 0, 0);

  // --- Step 2: Dilate via offset draws ---
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");

  // Single ring at full strokeWidth with many angular steps
  const steps = Math.max(64, Math.ceil(strokeWidth * 6));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ctx.drawImage(mask, Math.cos(a) * strokeWidth, Math.sin(a) * strokeWidth, w, h);
  }

  // --- Step 3: Fill with outline color, cut out original ---
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = OUTLINE_COLOR;
  ctx.fillRect(0, 0, w, h);

  // Cut out the original shape
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(mask, 0, 0, w, h);

  return c;
}

/**
 * High-contrast duotone halftone — Flora AI screen-print look.
 *
 * Key difference from previous versions:
 * - HIGHLIGHTS ARE CLEAN: brightest areas = pure paper, NO dots
 * - DARKS ARE SOLID: darkest areas = nearly solid ink, dots fully merged
 * - Strong S-curve contrast for dramatic tonal separation
 * - Auto-normalizes brightness range per image for consistent results
 */
function createHalftone(img, w, h, dotSpacing, darkColor, lightColor, maxDotPct, contrastGamma) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tmpCtx = tmp.getContext("2d");
  tmpCtx.drawImage(img, 0, 0, w, h);
  const data = tmpCtx.getImageData(0, 0, w, h).data;

  // --- Pass 1: Collect all brightness values to normalize ---
  const brightValues = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 20) {
      brightValues.push(
        (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
      );
    }
  }

  // Find 5th and 95th percentile for robust normalization
  brightValues.sort((a, b) => a - b);
  const lo = brightValues[Math.floor(brightValues.length * 0.05)] || 0;
  const hi = brightValues[Math.floor(brightValues.length * 0.95)] || 1;
  const range = hi - lo || 1;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");

  // Fill subject silhouette with off-white paper color
  ctx.drawImage(img, 0, 0, w, h);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = lightColor;
  ctx.fillRect(0, 0, w, h);

  // Draw halftone dots, constrained to silhouette
  ctx.globalCompositeOperation = "source-atop";

  const step = dotSpacing;
  // maxDotPct controls how large dots can get relative to the grid step.
  // < 50 = dots never touch. 50 = dots just touch. > 50 = dots overlap/merge.
  const maxR = step * (maxDotPct / 100);
  const [dr, dg, db] = hexToRgb(darkColor);

  // Sigmoid S-curve: higher gamma = more contrast (steeper curve)
  const gamma = contrastGamma;
  function sigmoid(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const xg = Math.pow(x, gamma);
    return xg / (xg + Math.pow(1 - x, gamma));
  }

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      let bright = 0,
        alpha = 0,
        n = 0;

      for (let dy = 0; dy < step && y + dy < h; dy++) {
        for (let dx = 0; dx < step && x + dx < w; dx++) {
          const idx = ((y + dy) * w + (x + dx)) * 4;
          if (data[idx + 3] > 20) {
            bright +=
              (0.299 * data[idx] +
                0.587 * data[idx + 1] +
                0.114 * data[idx + 2]) /
              255;
            alpha += data[idx + 3] / 255;
            n++;
          }
        }
      }

      if (n === 0) continue;

      const avgBright = bright / n;
      const avgAlpha = alpha / n;

      // Normalize brightness to full tonal range
      const normalized = Math.max(0, Math.min(1, (avgBright - lo) / range));
      const darkness = 1 - normalized;

      // Apply sigmoid — highlights become paper, darks become large dots
      const curved = sigmoid(darkness);

      // Skip brightest areas — pure clean paper, no dots
      if (curved < 0.02) continue;

      const radius = curved * maxR;

      ctx.beginPath();
      ctx.arc(x + step / 2, y + step / 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${dr},${dg},${db},${avgAlpha})`;
      ctx.fill();
    }
  }

  return out;
}

/* ── Main Component ──────────────────────────────── */

export default function PortraitEffectTool() {
  const [rawUrl, setRawUrl] = useState(null);
  const [strokeWidth, setStrokeWidth] = useState(12);
  const [dotSpacing, setDotSpacing] = useState(4);
  const [inkDarkness, setInkDarkness] = useState(15);   // 0=bg color, 100=black
  const [maxDotSize, setMaxDotSize] = useState(46);      // % of step (50=touching)
  const [contrast, setContrast] = useState(25);           // mapped to gamma 1.0-5.0
  const [previewBg, setPreviewBg] = useState("#1E4D4A");
  const [status, setStatus] = useState("idle");
  const [progressMsg, setProgressMsg] = useState("");
  const [imageReady, setImageReady] = useState(0);

  const canvasRef = useRef(null);
  const outputRef = useRef(null);
  const imgRef = useRef(null);

  /* ── Upload + automatic background removal ──── */
  async function handleUpload(e) {
    e.preventDefault?.();
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    if (e.target) e.target.value = "";

    setStatus("uploading");
    setProgressMsg("Afbeelding laden...");

    const url = URL.createObjectURL(file);
    setRawUrl(url);

    const tempImg = new Image();
    tempImg.src = url;
    await new Promise((r) => {
      tempImg.onload = r;
      tempImg.onerror = r;
    });

    if (!tempImg.naturalWidth) {
      setStatus("error");
      setProgressMsg("Kan afbeelding niet laden. Controleer het bestand.");
      return;
    }

    let finalUrl = url;

    if (!hasTransparency(tempImg)) {
      setStatus("removing-bg");
      setProgressMsg("AI model laden...");

      try {
        // Pass the File blob directly — more reliable than object URLs
        // which can cause CORS/fetch issues in some browsers
        const blob = await removeBackground(file, {
          progress: (key, current, total) => {
            if (key.includes("download") || key.includes("fetch")) {
              const pct = total > 0 ? Math.round((current / total) * 100) : 0;
              setProgressMsg(
                pct > 0
                  ? `AI model downloaden... ${pct}%`
                  : "AI model downloaden (eenmalig)..."
              );
            } else if (key.includes("compute") || key.includes("inference")) {
              const pct = total > 0 ? Math.round((current / total) * 100) : 0;
              setProgressMsg(`Achtergrond verwijderen... ${pct}%`);
            }
          },
        });
        finalUrl = URL.createObjectURL(blob);
      } catch (err) {
        console.error("Background removal failed:", err);
        setStatus("error");
        setProgressMsg(
          `Achtergrond verwijderen mislukt: ${err.message || "onbekende fout"}. Probeer een andere foto of upload een transparante PNG.`
        );
        return;
      }
    } else {
      setProgressMsg("Transparant beeld gedetecteerd ✓");
    }

    const img = new Image();
    img.src = finalUrl;
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
    });

    if (!img.naturalWidth) {
      setStatus("error");
      setProgressMsg("Kan verwerkt beeld niet laden.");
      return;
    }

    imgRef.current = img;
    setImageReady(Date.now());
  }

  /* ── Apply effects when image or settings change ──── */
  useEffect(() => {
    if (!imageReady || !imgRef.current) return;

    const img = imgRef.current;
    setStatus("processing");
    setProgressMsg("Effect toepassen...");

    const timer = setTimeout(() => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const dt = deriveDuotone(previewBg, inkDarkness);
      // Map contrast slider (0-100) to gamma (1.0-5.0)
      const gamma = 1.0 + (contrast / 100) * 4.0;

      const halftone = createHalftone(img, W, H, dotSpacing, dt.dark, dt.light, maxDotSize, gamma);
      const outline = createOutline(img, strokeWidth, W, H);

      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const ctx = out.getContext("2d");
      ctx.drawImage(outline, 0, 0);
      ctx.drawImage(halftone, 0, 0);
      outputRef.current = out;

      const preview = canvasRef.current;
      if (preview) {
        preview.width = W;
        preview.height = H;
        const pCtx = preview.getContext("2d");
        pCtx.fillStyle = previewBg;
        pCtx.fillRect(0, 0, W, H);
        pCtx.drawImage(out, 0, 0);
      }

      setStatus("done");
      setProgressMsg("");
    }, 50);

    return () => clearTimeout(timer);
  }, [imageReady, previewBg, strokeWidth, dotSpacing, inkDarkness, maxDotSize, contrast]);

  /* ── Download ──── */
  function download(format) {
    const canvas = outputRef.current;
    if (!canvas) return;
    const a = document.createElement("a");
    a.download = `portrait.${format}`;
    a.href = canvas.toDataURL(
      format === "webp" ? "image/webp" : "image/png",
      0.95
    );
    a.click();
  }

  const isProcessing = ["uploading", "removing-bg", "processing"].includes(
    status
  );

  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        background: "#F5F0E8",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <header
        style={{
          background: "#1A1A1A",
          color: "white",
          padding: "14px 28px",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.5px" }}>
          MarcoToday
        </span>
        <span
          style={{
            background: "#5B2D6E",
            color: "white",
            fontSize: 10,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 4,
            textTransform: "uppercase",
            letterSpacing: "0.8px",
          }}
        >
          Portrait Tool
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#666" }}>
          Upload JPG of PNG — output is altijd transparant
        </span>
      </header>

      <main
        style={{
          flex: 1,
          display: "flex",
          maxWidth: 1100,
          margin: "0 auto",
          width: "100%",
          padding: "32px 24px",
          gap: 40,
        }}
      >
        {/* Controls */}
        <aside style={{ width: 256, flexShrink: 0 }}>
          <SectionLabel>Afbeelding</SectionLabel>
          <label
            htmlFor="fileInput"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleUpload}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              border: `2px dashed ${rawUrl ? "#5B2D6E" : "#C8C0B8"}`,
              borderRadius: 10,
              padding: "20px 12px",
              cursor: "pointer",
              background: rawUrl ? "#F0E8F8" : "white",
              textAlign: "center",
              transition: "all 0.2s",
              marginBottom: 24,
            }}
          >
            <input
              id="fileInput"
              type="file"
              accept="image/*"
              onChange={handleUpload}
              style={{ display: "none" }}
            />
            <div style={{ fontSize: 24, marginBottom: 6 }}>
              {rawUrl ? "🔄" : "⬆️"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>
              {rawUrl ? "Ander bestand" : "Upload foto (JPG of PNG)"}
            </div>
            <div style={{ fontSize: 11, color: "#999", marginTop: 3 }}>
              JPG wordt automatisch uitgeknipt
            </div>
          </label>

          {imageReady > 0 && (
            <>
              <SectionLabel>Outline</SectionLabel>
              <RangeControl
                label="Dikte"
                value={strokeWidth}
                min={4}
                max={50}
                onChange={setStrokeWidth}
                unit="px"
              />
              <div style={{ marginBottom: 24 }} />

              <SectionLabel>Halftone raster</SectionLabel>
              <RangeControl
                label="Dot afstand"
                value={dotSpacing}
                min={3}
                max={16}
                onChange={setDotSpacing}
                unit="px"
              />
              <div style={{ height: 8 }} />
              <RangeControl
                label="Max dot grootte"
                value={maxDotSize}
                min={20}
                max={75}
                onChange={setMaxDotSize}
                unit="%"
              />
              <p style={{ fontSize: 10, color: "#aaa", margin: "2px 0 0" }}>
                {'< 50 = ruimte tussen dots · 50 = raken · > 50 = overlappen'}
              </p>
              <div style={{ height: 8 }} />
              <RangeControl
                label="Contrast"
                value={contrast}
                min={0}
                max={100}
                onChange={setContrast}
                unit=""
              />
              <p style={{ fontSize: 10, color: "#aaa", margin: "2px 0 0" }}>
                Laag = zachte gradatie · Hoog = harde scheiding licht/donker
              </p>
              <div style={{ height: 8 }} />
              <RangeControl
                label="Inkt donkerheid"
                value={inkDarkness}
                min={0}
                max={80}
                onChange={setInkDarkness}
                unit="%"
              />
              <p style={{ fontSize: 10, color: "#aaa", margin: "2px 0 0" }}>
                0% = zelfde als achtergrond · 80% = bijna zwart
              </p>
              <div style={{ marginBottom: 24 }} />

              <SectionLabel>Voorbeeldkleur</SectionLabel>
              <p
                style={{
                  fontSize: 11,
                  color: "#888",
                  margin: "0 0 10px",
                  lineHeight: 1.4,
                }}
              >
                Bepaalt de duotone tint. In Webflow wordt kleur via CMS
                gekozen.
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 24,
                }}
              >
                {PREVIEW_COLORS.map((p) => (
                  <button
                    key={p.value}
                    title={p.label}
                    onClick={() => setPreviewBg(p.value)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      background: p.value,
                      cursor: "pointer",
                      border:
                        previewBg === p.value
                          ? "3px solid #1A1A1A"
                          : "2px solid rgba(0,0,0,0.1)",
                      outline:
                        previewBg === p.value ? "2px solid white" : "none",
                      outlineOffset: "-4px",
                      transition: "transform 0.1s",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.transform = "scale(1.15)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.transform = "scale(1)")
                    }
                  />
                ))}
                <input
                  type="color"
                  value={previewBg}
                  onChange={(e) => setPreviewBg(e.target.value)}
                  style={{
                    width: 28,
                    height: 28,
                    padding: 0,
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                  title="Aangepaste kleur"
                />
              </div>

              {status === "done" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <DownloadBtn
                    label="↓ PNG"
                    onClick={() => download("png")}
                    primary
                  />
                  <DownloadBtn
                    label="↓ WebP"
                    onClick={() => download("webp")}
                  />
                </div>
              )}
            </>
          )}

          <div
            style={{
              marginTop: 20,
              padding: 12,
              background: "white",
              borderRadius: 8,
              fontSize: 11,
              color: "#777",
              lineHeight: 1.6,
              border: "1px solid #E8E3DA",
            }}
          >
            <strong style={{ color: "#333" }}>📌 Zo werkt het</strong>
            <br />
            Upload een foto → achtergrond wordt automatisch verwijderd →
            duotone halftone + outline → download transparant bestand voor
            Webflow CMS.
          </div>
        </aside>

        {/* Preview */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel>Preview</SectionLabel>
          <div
            style={{
              background: rawUrl ? previewBg : "#E8E3DA",
              borderRadius: 14,
              minHeight: 500,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              overflow: "hidden",
              transition: "background 0.3s",
              boxShadow: "0 2px 20px rgba(0,0,0,0.08)",
            }}
          >
            {!rawUrl && (
              <div style={{ textAlign: "center", color: "rgba(0,0,0,0.2)" }}>
                <div style={{ fontSize: 52, marginBottom: 10 }}>👤</div>
                <div style={{ fontSize: 14 }}>
                  Upload een portret om te starten
                </div>
              </div>
            )}

            {isProcessing && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.55)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 10,
                  gap: 14,
                }}
              >
                <SpinIcon />
                <div style={{ fontSize: 14, color: "white", fontWeight: 600 }}>
                  {progressMsg}
                </div>
                {status === "removing-bg" && (
                  <div
                    style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}
                  >
                    Dit duurt 10-30 sec (eerste keer langer)
                  </div>
                )}
              </div>
            )}

            {status === "error" && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(196,48,45,0.12)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 10,
                  gap: 8,
                  padding: 32,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 28 }}>⚠️</div>
                <div style={{ fontSize: 13, color: "#C4302D", fontWeight: 600 }}>
                  {progressMsg}
                </div>
              </div>
            )}

            <canvas
              ref={canvasRef}
              style={{
                maxWidth: "100%",
                maxHeight: 620,
                display: rawUrl ? "block" : "none",
              }}
            />
          </div>

          {status === "done" && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 14px",
                background: "white",
                borderRadius: 8,
                fontSize: 12,
                color: "#555",
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
                border: "1px solid #E8E3DA",
              }}
            >
              <span>✅ Klaar</span>
              <span>
                Outline: <strong>{strokeWidth}px</strong>
              </span>
              <span>
                Dots: <strong>{dotSpacing}px</strong> / <strong>{maxDotSize}%</strong>
              </span>
              <span>
                Contrast: <strong>{contrast}</strong> · Inkt: <strong>{inkDarkness}%</strong>
              </span>
              <span style={{ marginLeft: "auto", color: "#999" }}>
                Transparant bestand
              </span>
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

/* ── Sub-components ──────────────────────────────── */

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.8px",
        color: "#888",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function RangeControl({ label, value, min, max, onChange, unit }) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, color: "#555" }}>{label}</span>
        <span
          style={{
            fontSize: 12,
            fontFamily: "monospace",
            color: "#5B2D6E",
            fontWeight: 700,
          }}
        >
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#5B2D6E" }}
      />
    </div>
  );
}

function DownloadBtn({ label, onClick, primary }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: primary ? "#1A1A1A" : "white",
        color: primary ? "white" : "#1A1A1A",
        border: primary ? "none" : "1.5px solid #CCC",
        borderRadius: 8,
        padding: "12px 8px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
    >
      {label}
    </button>
  );
}

function SpinIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      style={{ animation: "spin 0.8s linear infinite", color: "white" }}
    >
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}
