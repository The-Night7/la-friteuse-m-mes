import React, { useEffect, useRef, useState } from 'react';

/**
 * This React component implements a simplified version of the deepfriedmemes.com
 * front‑end in TypeScript.  Users can upload an image, tweak various filter
 * settings (brightness, contrast, saturation, sharpen, noise, blur and
 * per‑channel colour multipliers) and perform repeated JPEG compression
 * passes to achieve the classic “deep fried” look.  Once satisfied the
 * user can save the processed image to their machine.
 *
 * The original site relies on jQuery, CamanJS and glfx.js.  This rewrite
 * instead uses the HTML5 canvas API directly and performs all pixel
 * manipulations in plain TypeScript.  The UI is built with React hooks,
 * eliminating the need for external dependencies such as jQuery.
 */

// Define an interface describing all of the adjustable settings.  These
// correspond to the sliders on the original site.  Values roughly follow
// the ranges used by deepfriedmemes.com.
interface FilterSettings {
  brightness: number; // [-10 … 30] default 15
  contrast: number;   // [0 … 300] default 155 (100 = neutral)
  saturation: number; // [0 … 300] default 0 (100 = neutral)
  sharpen: number;    // [0 … 800] default 83
  noise: number;      // [0 … 100] default 18
  /**
   * Blur radius measured in pixels.  A value of 0 leaves the image
   * untouched, while larger values apply a progressively stronger box
   * blur.  The range of 0–10 strikes a balance between performance and
   * effect.
   */
  blur: number;       // [0 … 10] default 0
  /**
   * Individual channel saturation multipliers.  Each channel slider
   * expresses its value such that 100 means “no change”, 200 doubles the
   * contribution of that colour and 50 halves it.  These adjustments
   * happen after global saturation but before sharpen and noise.
   */
  satR: number;       // [0 … 300] default 100
  satG: number;       // [0 … 300] default 100
  satB: number;       // [0 … 300] default 100
  jpegTimes: number;  // [1 … 200] default 28
  jpegQuality: number; // [0 … 0.5] default 0.175
}

/** Utility function to clamp a value between 0 and 255. */
function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/**
 * Apply brightness and contrast adjustments to a single colour component.
 * Brightness is interpreted as a percentage offset relative to 0–255.  A
 * brightness of 0 has no effect; positive values brighten the image and
 * negative values darken it.  Contrast is expressed such that 100 gives the
 * original image; values above 100 increase contrast and values below 100
 * decrease it.  The algorithm is based on a simple linear transform:
 *   new = (old - 128) * (contrast/100) + 128 + brightness
 */
function adjustBrightnessContrast(
  color: number,
  brightness: number,
  contrast: number
): number {
  // Convert brightness from its native range into an additive offset.  The
  // original slider spans −10 to 30 so use that directly as an additive
  // adjustment.
  const bOffset = brightness;
  // Convert contrast percentage into a multiplicative factor.  A value of 100
  // corresponds to factor=1; 200 corresponds to factor=2; 50 corresponds
  // to factor=0.5.
  const factor = contrast / 100;
  const newVal = (color - 128) * factor + 128 + bOffset;
  return clamp(newVal);
}

/**
 * Convert an RGB triple to HSL.  This helper is used for saturation
 * adjustments.  All channels are in the range [0, 255]; the returned HSL
 * values are in the ranges [0,1] for hue, [0,1] for saturation and [0,1] for
 * lightness.  Adapted from the algorithm described at
 * https://en.wikipedia.org/wiki/HSL_and_HSV#From_RGB.
 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, l];
}

/**
 * Convert an HSL triple back to RGB.  All arguments and return values are
 * expressed in the ranges [0,1] for H, S, L and [0,255] for RGB.  See
 * https://en.wikipedia.org/wiki/HSL_and_HSV#To_RGB for details.
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l; // achromatic
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

/**
 * Apply a simple sharpen convolution.  This kernel emphasises edges by
 * subtracting neighbouring pixels from a scaled centre.  The strength
 * parameter controls how pronounced the sharpening is: 0 yields no effect
 * whilst larger values produce a stronger effect.  A value around 80–100
 * produces a fairly strong sharpen similar to the default on deepfriedmemes.com.
 */
function applySharpen(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  strength: number
): Uint8ClampedArray {
  // Compute convolution coefficients.  We'll use a basic unsharp mask where
  // the centre weight increases with strength and surrounding weights are
  // negative fractions of that.  Because the user may set very high values
  // (the original range goes up to 800) we normalise by dividing by 100.
  const s = strength / 100;
  const centre = 1 + 4 * s;
  const neighbour = -s;
  const output = new Uint8ClampedArray(data);
  // Loop over each pixel excluding the outermost edge to avoid bounds checks.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const centreVal = data[idx + c] * centre;
        const top = data[idx + c - width * 4] * neighbour;
        const bottom = data[idx + c + width * 4] * neighbour;
        const left = data[idx + c - 4] * neighbour;
        const right = data[idx + c + 4] * neighbour;
        const newVal = centreVal + top + bottom + left + right;
        output[idx + c] = clamp(newVal);
      }
      // Preserve alpha channel
      output[idx + 3] = data[idx + 3];
    }
  }
  return output;
}

/**
 * Add random noise to an image.  Noise is generated as a uniformly
 * distributed value in ±amplitude/2.  The amplitude is proportional to the
 * user‐selected noise level: a value of 100 results in full ±255 range.
 */
function applyNoise(
  data: Uint8ClampedArray,
  amplitude: number
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data);
  const a = amplitude / 100 * 255;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * a;
    output[i] = clamp(data[i] + noise);
    output[i + 1] = clamp(data[i + 1] + noise);
    output[i + 2] = clamp(data[i + 2] + noise);
    // alpha remains unchanged
  }
  return output;
}

/**
 * Apply a box blur to the image data.  The blur is computed using a
 * square window of side length `(2 * radius + 1)` centred on each pixel.
 * For performance reasons the radius is clamped to a maximum of 10.
 *
 * Note that the alpha channel is also blurred to avoid fringing.  If you
 * prefer to preserve alpha simply copy it from the original data array
 * instead of averaging it.
 */
function applyBlur(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number
): Uint8ClampedArray {
  const r = Math.min(Math.floor(radius), 10);
  if (r <= 0) {
    // No blur requested; return a shallow copy of the original.
    return new Uint8ClampedArray(data);
  }
  const output = new Uint8ClampedArray(data.length);
  // Iterate over each pixel and compute the average over the window.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const idx = (ny * width + nx) * 4;
          sumR += data[idx];
          sumG += data[idx + 1];
          sumB += data[idx + 2];
          sumA += data[idx + 3];
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

/**
 * Apply per‑channel saturation.  Each channel is multiplied by its own
 * factor.  The factors are percentages where 100 means no change, 200
 * doubles the channel intensity and 50 halves it.  Because multiplying
 * channels can easily exceed 255 we clamp the result.
 */
function applyChannelSaturation(
  data: Uint8ClampedArray,
  factorR: number,
  factorG: number,
  factorB: number
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(data);
  const fR = factorR / 100;
  const fG = factorG / 100;
  const fB = factorB / 100;
  for (let i = 0; i < data.length; i += 4) {
    output[i] = clamp(data[i] * fR);
    output[i + 1] = clamp(data[i + 1] * fG);
    output[i + 2] = clamp(data[i + 2] * fB);
    output[i + 3] = data[i + 3];
  }
  return output;
}

/**
 * Apply a JPEG compression loop to the provided canvas.  It uses
 * `canvas.toDataURL('image/jpeg', quality)` to obtain a degraded version,
 * creates an off‑screen image from this DataURL and draws it back onto the
 * canvas.  Repeating this multiple times compounds the artifacts.  This
 * function returns a promise because image loading is asynchronous.
 */
async function degradeCanvas(
  canvas: HTMLCanvasElement,
  times: number,
  quality: number
): Promise<void> {
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

/**
 * The main application component.  It renders the UI and orchestrates image
 * loading, filter application and downloading of the final result.
 */
const App: React.FC = () => {
  // State for the uploaded image.  `originalImage` is an HTMLImageElement
  // used as the source for drawing onto the canvas.  Using an Image object
  // avoids repeatedly decoding the DataURL when applying filters.
  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(
    null
  );

  // State for all filter settings.
  const [settings, setSettings] = useState<FilterSettings>({
    brightness: 15,
    contrast: 155,
    saturation: 0,
    sharpen: 83,
    noise: 18,
    blur: 0,
    satR: 100,
    satG: 100,
    satB: 100,
    jpegTimes: 28,
    jpegQuality: 0.175,
  });

  // JPEG application location – whether to run degradation before and/or after
  // the other filters.  In the original site users can choose either or both.
  const [jpegBefore, setJpegBefore] = useState<boolean>(false);
  const [jpegAfter, setJpegAfter] = useState<boolean>(true);

  // Reference to the canvas element.  We perform all rendering through this
  // canvas rather than drawing into the DOM tree directly.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /**
   * Called whenever the file input changes.  Reads the selected file as a
   * DataURL, loads it into an Image object and updates state.  Once the
   * image has loaded we trigger filter application.
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result;
      if (typeof src === 'string') {
        const img = new Image();
        img.onload = () => {
          setOriginalImage(img);
        };
        img.src = src;
      }
    };
    reader.readAsDataURL(file);
  };

  /**
   * Triggered whenever the user adjusts a slider or checkbox.  It updates
   * `settings` immutably, preserving previous values for unaffected fields.
   */
  const handleSliderChange = (
    field: keyof FilterSettings,
    value: number
  ) => {
    setSettings((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * This effect reacts to changes in the image or any filter settings.  It
   * performs all image processing: drawing the original image onto the canvas,
   * optionally applying JPEG degradation before filtering, adjusting
   * brightness/contrast/saturation/sharpen/noise and finally applying JPEG
   * degradation after filtering if requested.  If no image is loaded the
   * canvas remains empty.
   */
  useEffect(() => {
    if (!originalImage || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Compute a maximum width of 800 pixels whilst preserving the aspect ratio.
    const maxWidth = 800;
    const ratio = originalImage.width / originalImage.height;
    const width = Math.min(maxWidth, originalImage.width);
    const height = width / ratio;
    canvas.width = width;
    canvas.height = height;
    // Draw the original image on the canvas.
    ctx.drawImage(originalImage, 0, 0, width, height);
    // Perform JPEG degradation before applying filters if selected.
    const process = async () => {
      if (jpegBefore) {
        await degradeCanvas(canvas, settings.jpegTimes, settings.jpegQuality);
      }
      // Extract pixel data for manipulation.
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let data = imageData.data;
      // 1. Brightness & contrast.  Adjust each RGB channel independently.
      for (let i = 0; i < data.length; i += 4) {
        data[i] = adjustBrightnessContrast(data[i], settings.brightness, settings.contrast);
        data[i + 1] = adjustBrightnessContrast(data[i + 1], settings.brightness, settings.contrast);
        data[i + 2] = adjustBrightnessContrast(data[i + 2], settings.brightness, settings.contrast);
      }
      // 2. Global saturation.  Convert to HSL and multiply S component by satFactor.
      const satFactor = (settings.saturation + 100) / 100;
      for (let i = 0; i < data.length; i += 4) {
        const rVal = data[i];
        const gVal = data[i + 1];
        const bVal = data[i + 2];
        const [h, s, l] = rgbToHsl(rVal, gVal, bVal);
        const newS = Math.min(1, s * satFactor);
        const [nr, ng, nb] = hslToRgb(h, newS, l);
        data[i] = nr;
        data[i + 1] = ng;
        data[i + 2] = nb;
      }
      // 3. Blur.  If the blur radius is non‑zero we apply a box blur to the
      // current pixel data and replace it.  Blur must work on a copy of
      // data because applyBlur returns a fresh array.
      if (settings.blur > 0) {
        const blurred = applyBlur(data, canvas.width, canvas.height, settings.blur);
        data = blurred;
      }
      // 4. Per‑channel saturation.  Multiply each channel by its factor.
      if (settings.satR !== 100 || settings.satG !== 100 || settings.satB !== 100) {
        const saturated = applyChannelSaturation(data, settings.satR, settings.satG, settings.satB);
        data = saturated;
      }
      // 5. Sharpen.  Use convolution to emphasise edges if requested.
      if (settings.sharpen > 0) {
        const sharpened = applySharpen(data, canvas.width, canvas.height, settings.sharpen);
        data = sharpened;
      }
      // 6. Noise.  Add random noise to the image if requested.
      if (settings.noise > 0) {
        const noised = applyNoise(data, settings.noise);
        data = noised;
      }
      // Put the modified pixel data back onto the canvas.  If we replaced
      // `data` with a new buffer we need to construct a new ImageData object.
      if (data !== imageData.data) {
        const newImage = new ImageData(data as Uint8ClampedArray, canvas.width, canvas.height);
        ctx.putImageData(newImage, 0, 0);
      } else {
        ctx.putImageData(imageData, 0, 0);
      }
      // Apply JPEG degradation after filtering if selected.
      if (jpegAfter) {
        await degradeCanvas(canvas, settings.jpegTimes, settings.jpegQuality);
      }
    };
    process();
    // We deliberately omit `ctx` and `canvas` from the dependency array because
    // React recreates refs infrequently; including them would cause
    // unnecessary reprocessing.
  }, [originalImage, settings, jpegBefore, jpegAfter]);

  /**
   * Download the processed image.  We convert the canvas into a JPEG
   * DataURL and generate an anchor element with a `download` attribute to
   * trigger the download.  The resulting filename mirrors the original site
   * (`deepfried_<timestamp>.jpg`).
   */
  const handleDownload = () => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/jpeg', 0.95);
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `deepfried_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="app-container">
      <header>
        <ul className="community-links">
          <li>
            <span className="tooltip" data-tooltip="Deep Fried Memes are a style of meme wherein an image is run through dozens of filters until it appears grainy, washed‑out and colour shifted.">
              What is this?
            </span>
          </li>
        </ul>
        <h3>La friteuse à mèmes <span role="img" aria-label="OK hand">👌</span></h3>
      </header>
      <main className="main-content">
        <section className="controls">
          <div className="file-input">
            <input
              id="imageLoader"
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <label htmlFor="imageLoader" className="button">
              Browse (or paste)
            </label>
          </div>
          {originalImage && (
            <div className="filters">
              <details open>
                <summary>Filters</summary>
                <div className="slider">
                  <label>
                    brightness ({settings.brightness})
                    <input
                      type="range"
                      min={-10}
                      max={30}
                      step={1}
                      value={settings.brightness}
                      onChange={(e) =>
                        handleSliderChange('brightness', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    contrast ({settings.contrast})
                    <input
                      type="range"
                      min={0}
                      max={300}
                      step={1}
                      value={settings.contrast}
                      onChange={(e) =>
                        handleSliderChange('contrast', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    saturation ({settings.saturation})
                    <input
                      type="range"
                      min={0}
                      max={300}
                      step={1}
                      value={settings.saturation}
                      onChange={(e) =>
                        handleSliderChange('saturation', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    sharpen ({settings.sharpen})
                    <input
                      type="range"
                      min={0}
                      max={800}
                      step={1}
                      value={settings.sharpen}
                      onChange={(e) =>
                        handleSliderChange('sharpen', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    noise ({settings.noise})
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={settings.noise}
                      onChange={(e) =>
                        handleSliderChange('noise', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    blur ({settings.blur})
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={settings.blur}
                      onChange={(e) =>
                        handleSliderChange('blur', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    red channel ({settings.satR})
                    <input
                      type="range"
                      min={0}
                      max={300}
                      step={1}
                      value={settings.satR}
                      onChange={(e) =>
                        handleSliderChange('satR', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    green channel ({settings.satG})
                    <input
                      type="range"
                      min={0}
                      max={300}
                      step={1}
                      value={settings.satG}
                      onChange={(e) =>
                        handleSliderChange('satG', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    blue channel ({settings.satB})
                    <input
                      type="range"
                      min={0}
                      max={300}
                      step={1}
                      value={settings.satB}
                      onChange={(e) =>
                        handleSliderChange('satB', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
              </details>
              <details open>
                <summary>JPEG</summary>
                <div className="toggle-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={jpegBefore}
                      onChange={(e) => setJpegBefore(e.target.checked)}
                    />
                    <span>before filters</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={jpegAfter}
                      onChange={(e) => setJpegAfter(e.target.checked)}
                    />
                    <span>after filters</span>
                  </label>
                </div>
                <div className="slider">
                  <label>
                    repetitions ({settings.jpegTimes})
                    <input
                      type="range"
                      min={1}
                      max={200}
                      step={1}
                      value={settings.jpegTimes}
                      onChange={(e) =>
                        handleSliderChange('jpegTimes', parseInt(e.target.value, 10))
                      }
                    />
                  </label>
                </div>
                <div className="slider">
                  <label>
                    quality ({settings.jpegQuality.toFixed(3)})
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.025}
                      value={settings.jpegQuality}
                      onChange={(e) =>
                        handleSliderChange('jpegQuality', parseFloat(e.target.value))
                      }
                    />
                  </label>
                </div>
              </details>
              {/* Bulge panel omitted for brevity.  Implementing interactive
                  bulges requires complex warping which is beyond the scope of
                  this simplified rewrite. */}
            </div>
          )}
        </section>
        <section className="canvas-section">
          <canvas ref={canvasRef} />
          {originalImage && (
            <div className="actions">
              <button className="button" onClick={handleDownload}>
                Save Image
              </button>
            </div>
          )}
        </section>
      </main>
      <footer>
        <span style={{ float: 'left' }}>
          Built by <a href="https://dmitry.lol" target="_blank" rel="noopener noreferrer">Dima</a>.
        </span>
        <span>
          <a href="#privacy">Privacy Policy</a>
        </span>{' '}
        |
        <span>
          <a href="https://github.com/efskap/deepfriedmemes.com" target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
        </span>
      </footer>
    </div>
  );
};

export default App;