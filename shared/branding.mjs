export const brandingDefaults = {
  overlayEnabled: false, overlayName: 'Your channel', followText: 'FOLLOW ME', subscribeText: 'SUBSCRIBE NOW',
};

export function brandingLayout(frame, settings = {}) {
  const { width, height } = frame;
  const top = Math.round(height * 0.15 / 2) * 2;
  const bottom = Math.round(height * 0.18 / 2) * 2;
  const values = { ...brandingDefaults, ...settings };
  const typeWidth = Math.min(width, height * 9 / 16);
  const line = (key, text, ratio, y) => ({
    key, text, y: Math.round(y),
    fontSize: Math.max(10, Math.floor(Math.min(typeWidth * ratio, width * 0.86 / Math.max(1, Array.from(text).length * 0.85)))),
  });
  return {
    enabled: values.overlayEnabled === true, top, bottom, contentHeight: height - top - bottom,
    lines: [
      line('follow', values.followText, 0.035, top * 0.14),
      line('name-top', values.overlayName, 0.075, top * 0.46),
      line('subscribe', values.subscribeText, 0.10, height - bottom + bottom * 0.12),
      line('name-bottom', values.overlayName, 0.045, height - bottom + bottom * 0.53),
      line('actions', 'LIKE  |  COMMENT  |  SHARE', 0.027, height - bottom + bottom * 0.82),
    ],
  };
}
