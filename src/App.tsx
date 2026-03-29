import React, { useEffect, useRef, useState } from 'react';
import './App.css';

interface FilterSettings {
  brightness: number; contrast: number; saturation: number; sharpen: number;
  noise: number; blur: number; satR: number; satG: number; satB: number;
  jpegTimes: number; jpegQuality: number;
}

// --- Fonctions utilitaires ---
function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}

// Les filtres spatiaux (Flou et Netteté) doivent garder leurs propres boucles
function applySharpen(data: Uint8ClampedArray, width: number, height: number, strength: number): Uint8ClampedArray {
  const s = strength / 100;
  const centre = 1 + 4 * s;
  const neighbour = -s;
  const output = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const centreVal = data[idx + c] * centre;
        const top = data[idx + c - width * 4] * neighbour;
        const bottom = data[idx + c + width * 4] * neighbour;
        const left = data[idx + c - 4] * neighbour;
        const right = data[idx + c + 4] * neighbour;
        output[idx + c] = clamp(centreVal + top + bottom + left + right);
      }
      output[idx + 3] = data[idx + 3];
    }
  }
  return output;
}

function applyBlur(data: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  const r = Math.min(Math.floor(radius), 10);
  if (r <= 0) return new Uint8ClampedArray(data);
  const output = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const idx = (ny * width + nx) * 4;
          sumR += data[idx]; sumG += data[idx + 1]; sumB += data[idx + 2]; sumA += data[idx + 3];
          count++;
        }
      }
      const destIdx = (y * width + x) * 4;
      output[destIdx] = sumR / count; output[destIdx + 1] = sumG / count;
      output[destIdx + 2] = sumB / count; output[destIdx + 3] = sumA / count;
    }
  }
  return output;
}

async function degradeCanvas(canvas: HTMLCanvasElement, times: number, quality: number): Promise<void> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  for (let i = 0; i < times; i++) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve();
      };
      img.src = dataUrl;
    });
  }
}

// --- Le composant React ---
const App: React.FC = () => {
  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null);
  
  // L'état en temps réel pour l'UI (les curseurs)
  const [settings, setSettings] = useState<FilterSettings>({
    brightness: 15, contrast: 155, saturation: 0, sharpen: 83, noise: 18, blur: 0,
    satR: 100, satG: 100, satB: 100, jpegTimes: 28, jpegQuality: 0.175,
  });
  const [jpegBefore, setJpegBefore] = useState<boolean>(false);
  const [jpegAfter, setJpegAfter] = useState<boolean>(true);

  // Les états debouncés (retardés) pour le calcul lourd
  const [debouncedSettings, setDebouncedSettings] = useState<FilterSettings>(settings);
  const [debouncedJpegBefore, setDebouncedJpegBefore] = useState(jpegBefore);
  const [debouncedJpegAfter, setDebouncedJpegAfter] = useState(jpegAfter);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // --- Gestion du fichier ---
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result;
      if (typeof src === 'string') {
        const img = new Image();
        img.onload = () => setOriginalImage(img);
        img.src = src;
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSliderChange = (field: keyof FilterSettings, value: number) => {
    setSettings((prev) => ({ ...prev, [field]: value }));
  };

  // --- Le "Debouncer" ---
  // Met à jour les valeurs de traitement 150ms après que l'utilisateur ait fini de bouger un curseur
  useEffect(() => {
    setIsProcessing(true);
    const timer = setTimeout(() => {
      setDebouncedSettings(settings);
      setDebouncedJpegBefore(jpegBefore);
      setDebouncedJpegAfter(jpegAfter);
    }, 150);
    return () => clearTimeout(timer);
  }, [settings, jpegBefore, jpegAfter]);

  // --- Le Traitement d'Image (Ultra Optimisé) ---
  useEffect(() => {
    if (!originalImage || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    
    const maxWidth = 800;
    const ratio = originalImage.width / originalImage.height;
    const width = Math.min(maxWidth, originalImage.width);
    const height = width / ratio;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(originalImage, 0, 0, width, height);

    const process = async () => {
      if (debouncedJpegBefore) await degradeCanvas(canvas, debouncedSettings.jpegTimes, debouncedSettings.jpegQuality);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let data: any = imageData.data;
      
      // Pré-calcul des facteurs pour éviter de faire le calcul à chaque pixel
      const bOffset = debouncedSettings.brightness;
      const cFactor = debouncedSettings.contrast / 100;
      const satFactor = (debouncedSettings.saturation + 100) / 100;
      const fR = debouncedSettings.satR / 100;
      const fG = debouncedSettings.satG / 100;
      const fB = debouncedSettings.satB / 100;
      const noiseAmp = (debouncedSettings.noise / 100) * 255;

      // FUSION DE BOUCLES : On fait la luminosité, le contraste, la saturation, le RGB et le bruit en un seul passage !
      for (let i = 0; i < data.length; i += 4) {
        // 1. Luminosité & Contraste
        let r = clamp((data[i] - 128) * cFactor + 128 + bOffset);
        let g = clamp((data[i + 1] - 128) * cFactor + 128 + bOffset);
        let b = clamp((data[i + 2] - 128) * cFactor + 128 + bOffset);

        // 2. Saturation globale
        if (satFactor !== 1) {
          const [h, s, l] = rgbToHsl(r, g, b);
          const newS = Math.min(1, s * satFactor);
          const rgb = hslToRgb(h, newS, l);
          r = rgb[0]; g = rgb[1]; b = rgb[2];
        }

        // 3. Canaux RGB
        r = clamp(r * fR); g = clamp(g * fG); b = clamp(b * fB);

        // 4. Bruit (Noise)
        if (noiseAmp > 0) {
          const noise = (Math.random() - 0.5) * noiseAmp;
          r = clamp(r + noise); g = clamp(g + noise); b = clamp(b + noise);
        }

        // Application finale
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
      
      // Filtres Spatiaux (nécessitent de lire les pixels voisins, donc passages séparés)
      if (debouncedSettings.blur > 0) data = applyBlur(data, canvas.width, canvas.height, debouncedSettings.blur) as any;
      if (debouncedSettings.sharpen > 0) data = applySharpen(data, canvas.width, canvas.height, debouncedSettings.sharpen) as any;
      
      if (data !== imageData.data) {
        ctx.putImageData(new ImageData(data as any, canvas.width, canvas.height), 0, 0);
      } else {
        ctx.putImageData(imageData, 0, 0);
      }
      
      if (debouncedJpegAfter) await degradeCanvas(canvas, debouncedSettings.jpegTimes, debouncedSettings.jpegQuality);
      
      setIsProcessing(false); // Fin du traitement !
    };
    
    process();
  }, [originalImage, debouncedSettings, debouncedJpegBefore, debouncedJpegAfter]);

  // --- Export ---
  const handleDownload = () => {
    if (!canvasRef.current) return;
    const link = document.createElement('a');
    link.href = canvasRef.current.toDataURL('image/jpeg', 0.95);
    link.download = `deepfried_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="app-container">
      <header>
        <h3>La friteuse à mèmes <span role="img" aria-label="OK hand">👌</span></h3>
      </header>
      <main className="main-content">
        <section className="controls">
          <div className="file-input">
            <input id="imageLoader" type="file" accept="image/*" onChange={handleFileChange} style={{ display: 'none' }} />
            <label htmlFor="imageLoader" className="button">Importer une image</label>
          </div>
          {originalImage && (
            <div className="filters">
              <details open>
                <summary>Filtres globaux</summary>
                <div className="slider">
                  <label>Luminosité ({settings.brightness})
                    <input type="range" min={-10} max={30} step={1} value={settings.brightness} onChange={(e) => handleSliderChange('brightness', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                <div className="slider">
                  <label>Contraste ({settings.contrast})
                    <input type="range" min={0} max={300} step={1} value={settings.contrast} onChange={(e) => handleSliderChange('contrast', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                <div className="slider">
                  <label>Saturation ({settings.saturation})
                    <input type="range" min={0} max={300} step={1} value={settings.saturation} onChange={(e) => handleSliderChange('saturation', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                <div className="slider">
                  <label>Netteté ({settings.sharpen})
                    <input type="range" min={0} max={800} step={1} value={settings.sharpen} onChange={(e) => handleSliderChange('sharpen', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                <div className="slider">
                  <label>Bruit ({settings.noise})
                    <input type="range" min={0} max={100} step={1} value={settings.noise} onChange={(e) => handleSliderChange('noise', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                <div className="slider">
                  <label>Flou ({settings.blur})
                    <input type="range" min={0} max={10} step={1} value={settings.blur} onChange={(e) => handleSliderChange('blur', parseInt(e.target.value, 10))} />
                  </label>
                </div>
              </details>

              <details open>
                <summary>Dégradation JPEG</summary>
                <div className="toggle-group" style={{ display: 'flex', gap: '15px', marginBottom: '10px' }}>
                  <label>
                    <input type="checkbox" checked={jpegBefore} onChange={(e) => setJpegBefore(e.target.checked)} />
                    <span> Avant les filtres</span>
                  </label>
                  <label>
                    <input type="checkbox" checked={jpegAfter} onChange={(e) => setJpegAfter(e.target.checked)} />
                    <span> Après les filtres</span>
                  </label>
                </div>
                <div className="slider">
                  <label>Répétitions ({settings.jpegTimes})
                    <input type="range" min={1} max={200} step={1} value={settings.jpegTimes} onChange={(e) => handleSliderChange('jpegTimes', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                <div className="slider">
                  <label>Qualité ({settings.jpegQuality.toFixed(3)})
                    <input type="range" min={0} max={0.5} step={0.025} value={settings.jpegQuality} onChange={(e) => handleSliderChange('jpegQuality', parseFloat(e.target.value))} />
                  </label>
                </div>
              </details>
            </div>
          )}
        </section>
        <section className="canvas-section" style={{ position: 'relative' }}>
          <canvas 
            ref={canvasRef} 
            style={{ 
              opacity: isProcessing ? 0.4 : 1, 
              transition: 'opacity 0.15s ease-in-out',
              maxWidth: '100%', height: 'auto', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
            }} 
          />
          {isProcessing && originalImage && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontWeight: 'bold', color: '#333', backgroundColor: 'rgba(255,255,255,0.8)', padding: '8px 16px', borderRadius: '20px' }}>
              Friture en cours... 🍟
            </div>
          )}
          {originalImage && !isProcessing && (
            <div className="actions" style={{ marginTop: '15px' }}>
              <button className="button" onClick={handleDownload} style={{ width: '100%', fontSize: '1.1rem', padding: '12px' }}>
                Sauvegarder l'image
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default App;