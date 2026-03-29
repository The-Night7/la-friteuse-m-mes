import React, { useEffect, useRef, useState } from 'react';
import './App.css'; // Assurez-vous d'importer votre CSS ici

// Définition des paramètres
interface FilterSettings {
  brightness: number; 
  contrast: number;   
  saturation: number; 
  sharpen: number;    
  noise: number;      
  blur: number;       
  satR: number;       
  satG: number;       
  satB: number;       
  jpegTimes: number;  
  jpegQuality: number; 
}

// --- Fonctions utilitaires ---
function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function adjustBrightnessContrast(color: number, brightness: number, contrast: number): number {
  const factor = contrast / 100;
  return clamp((color - 128) * factor + 128 + brightness);
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
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}

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

function applyNoise(data: Uint8ClampedArray, amplitude: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data);
  const a = (amplitude / 100) * 255;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * a;
    output[i] = clamp(data[i] + noise);
    output[i + 1] = clamp(data[i + 1] + noise);
    output[i + 2] = clamp(data[i + 2] + noise);
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
      output[destIdx] = sumR / count;
      output[destIdx + 1] = sumG / count;
      output[destIdx + 2] = sumB / count;
      output[destIdx + 3] = sumA / count;
    }
  }
  return output;
}

function applyChannelSaturation(data: Uint8ClampedArray, factorR: number, factorG: number, factorB: number): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data);
  const fR = factorR / 100, fG = factorG / 100, fB = factorB / 100;
  for (let i = 0; i < data.length; i += 4) {
    output[i] = clamp(data[i] * fR);
    output[i + 1] = clamp(data[i + 1] * fG);
    output[i + 2] = clamp(data[i + 2] * fB);
    output[i + 3] = data[i + 3];
  }
  return output;
}

async function degradeCanvas(canvas: HTMLCanvasElement, times: number, quality: number): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  for (let i = 0; i < times; i++) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
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
  const [settings, setSettings] = useState<FilterSettings>({
    brightness: 15, contrast: 155, saturation: 0, sharpen: 83, noise: 18, blur: 0,
    satR: 100, satG: 100, satB: 100, jpegTimes: 28, jpegQuality: 0.175,
  });
  const [jpegBefore, setJpegBefore] = useState<boolean>(false);
  const [jpegAfter, setJpegAfter] = useState<boolean>(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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

  useEffect(() => {
    if (!originalImage || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const maxWidth = 800;
    const ratio = originalImage.width / originalImage.height;
    const width = Math.min(maxWidth, originalImage.width);
    const height = width / ratio;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(originalImage, 0, 0, width, height);

    const process = async () => {
      if (jpegBefore) await degradeCanvas(canvas, settings.jpegTimes, settings.jpegQuality);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let data = imageData.data;
      
      for (let i = 0; i < data.length; i += 4) {
        data[i] = adjustBrightnessContrast(data[i], settings.brightness, settings.contrast);
        data[i + 1] = adjustBrightnessContrast(data[i + 1], settings.brightness, settings.contrast);
        data[i + 2] = adjustBrightnessContrast(data[i + 2], settings.brightness, settings.contrast);
      }
      
      const satFactor = (settings.saturation + 100) / 100;
      for (let i = 0; i < data.length; i += 4) {
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        const newS = Math.min(1, s * satFactor);
        const [nr, ng, nb] = hslToRgb(h, newS, l);
        data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
      }
      
      if (settings.blur > 0) data = applyBlur(data, canvas.width, canvas.height, settings.blur);
      
      if (settings.satR !== 100 || settings.satG !== 100 || settings.satB !== 100) {
        data = applyChannelSaturation(data, settings.satR, settings.satG, settings.satB);
      }
      
      if (settings.sharpen > 0) data = applySharpen(data, canvas.width, canvas.height, settings.sharpen);
      
      if (settings.noise > 0) data = applyNoise(data, settings.noise);
      
      if (data !== imageData.data) {
        ctx.putImageData(new ImageData(data as Uint8ClampedArray, canvas.width, canvas.height), 0, 0);
      } else {
        ctx.putImageData(imageData, 0, 0);
      }
      
      if (jpegAfter) await degradeCanvas(canvas, settings.jpegTimes, settings.jpegQuality);
    };
    process();
  }, [originalImage, settings, jpegBefore, jpegAfter]);

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
                <summary>Filtres</summary>
                <div className="slider">
                  <label>Luminosité ({settings.brightness})
                    <input type="range" min={-10} max={30} step={1} value={settings.brightness} onChange={(e) => handleSliderChange('brightness', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                {/* Les autres sliders (contraste, saturation, netteté...) sont identiques */}
                <div className="slider">
                  <label>Contraste ({settings.contrast})
                    <input type="range" min={0} max={300} step={1} value={settings.contrast} onChange={(e) => handleSliderChange('contrast', parseInt(e.target.value, 10))} />
                  </label>
                </div>
                <div className="slider">
                  <label>Dégradation JPEG ({settings.jpegTimes} passes)
                    <input type="range" min={1} max={200} step={1} value={settings.jpegTimes} onChange={(e) => handleSliderChange('jpegTimes', parseInt(e.target.value, 10))} />
                  </label>
                </div>
              </details>
            </div>
          )}
        </section>
        <section className="canvas-section">
          <canvas ref={canvasRef} />
          {originalImage && (
            <div className="actions">
              <button className="button" onClick={handleDownload}>Sauvegarder l'image</button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default App;