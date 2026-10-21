import React from 'react';
import { Video } from 'lucide-react';
import { brandingDefaults, brandingLayout } from '../shared/branding.mjs';

export function BrandingLayer({ frame, settings }) {
  const layout = brandingLayout(frame, settings);
  if (!layout.enabled) return null;
  return <svg className="branding-layer" viewBox={`0 0 ${frame.width} ${frame.height}`} aria-hidden="true">
    <image href="/stream-overlays/red-frame.png" width={frame.width} height={frame.height} />
    {layout.lines.map(line => <text key={line.key} x={frame.width / 2} y={line.y} fontSize={line.fontSize} textAnchor="middle" dominantBaseline="text-before-edge">{line.text}</text>)}
  </svg>;
}

export function BrandingSettings({ settings, disabled, available, onChange }) {
  const values = { ...brandingDefaults, ...settings };
  return <div className="branding-settings">
    <div className="branding-heading"><Video size={18} /><div><strong>Follow & Subscribe overlay</strong><span>Red & black banners with your name</span></div><button type="button" role="switch" aria-label="Follow and subscribe overlay" aria-checked={values.overlayEnabled} className={`toggle ${values.overlayEnabled ? 'on' : ''}`} disabled={disabled || !available} onClick={() => onChange('overlayEnabled', !values.overlayEnabled)}><span /></button></div>
    {!available && <p className="field-hint">Ready for your next stream. Stop the current stream to enable banners.</p>}
    {values.overlayEnabled && <div className="branding-fields">
      <label className="field"><span>Channel / display name</span><input aria-label="Overlay channel name" value={values.overlayName} maxLength={32} disabled={disabled} onChange={event => onChange('overlayName', event.target.value)} placeholder="e.g. Gaurav Gaming" /></label>
      <label className="field"><span>Top banner text</span><input aria-label="Top banner text" value={values.followText} maxLength={28} disabled={disabled} onChange={event => onChange('followText', event.target.value)} /></label>
      <label className="field"><span>Bottom banner text</span><input aria-label="Bottom banner text" value={values.subscribeText} maxLength={28} disabled={disabled} onChange={event => onChange('subscribeText', event.target.value)} /></label>
      <p className="field-hint">Your name appears on both banners. Video stays between them. Set these before starting your stream.</p>
    </div>}
  </div>;
}
