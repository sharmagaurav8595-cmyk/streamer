import React from 'react';
import { RotateCcw, Scan } from 'lucide-react';
import { framingDefaults, videoFraming } from '../shared/framing.mjs';

export default function FramingControls({ settings, disabled, onChange, onReset }) {
  const values = videoFraming(settings);
  const centered = Object.entries(framingDefaults).every(([key, value]) => values[key] === value);
  return <fieldset className="framing-controls" disabled={disabled}>
    <legend><Scan size={15} /> Adjust video</legend>
    <label><span>Zoom <output>{values.videoZoom.toFixed(2)}×</output></span><input aria-label="Video zoom" type="range" min="1" max="3" step="0.05" value={values.videoZoom} onChange={event => onChange('videoZoom', Number(event.target.value))} /><small><span>Full view</span><span>Crop closer</span></small></label>
    <label><span>Horizontal focus <output>{values.videoPositionX}%</output></span><input aria-label="Horizontal video position" type="range" min="0" max="100" step="1" value={values.videoPositionX} onChange={event => onChange('videoPositionX', Number(event.target.value))} /><small><span>Left</span><span>Right</span></small></label>
    <label><span>Vertical focus <output>{values.videoPositionY}%</output></span><input aria-label="Vertical video position" type="range" min="0" max="100" step="1" value={values.videoPositionY} onChange={event => onChange('videoPositionY', Number(event.target.value))} /><small><span>Top</span><span>Bottom</span></small></label>
    <details className="source-trim-controls"><summary>Remove borders in original video</summary><p>Crop out banners already baked into your source video.</p>
      <label><span>Crop from top <output>{values.sourceTrimTop}%</output></span><input aria-label="Source crop from top" type="range" min="0" max={Math.min(45, 80 - values.sourceTrimBottom)} step="0.5" value={values.sourceTrimTop} onChange={event => onChange('sourceTrimTop', Number(event.target.value))} /></label>
      <label><span>Crop from bottom <output>{values.sourceTrimBottom}%</output></span><input aria-label="Source crop from bottom" type="range" min="0" max={Math.min(45, 80 - values.sourceTrimTop)} step="0.5" value={values.sourceTrimBottom} onChange={event => onChange('sourceTrimBottom', Number(event.target.value))} /></label>
    </details>
    <div className="framing-controls-foot"><span>Only the video moves. Banners stay fixed.</span><button type="button" className="text-button" onClick={onReset} disabled={disabled || centered}><RotateCcw size={12} /> Reset framing</button></div>
  </fieldset>;
}
