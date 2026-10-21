export const framingDefaults = { videoZoom: 1, videoPositionX: 50, videoPositionY: 50, sourceTrimTop: 0, sourceTrimBottom: 0 };

export function videoFraming(settings = {}) {
  const bounded = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    videoZoom: bounded(settings.videoZoom, 1, 1, 3),
    videoPositionX: bounded(settings.videoPositionX, 50, 0, 100),
    videoPositionY: bounded(settings.videoPositionY, 50, 0, 100),
    sourceTrimTop: bounded(settings.sourceTrimTop, 0, 0, 45),
    sourceTrimBottom: bounded(settings.sourceTrimBottom, 0, 0, 45),
  };
}

export function sourceCropPreview(canvas, source, settings = {}) {
  const values = videoFraming(settings);
  if (!source?.width || !source?.height || (!values.sourceTrimTop && !values.sourceTrimBottom)) return null;
  const remaining = 1 - (values.sourceTrimTop + values.sourceTrimBottom) / 100;
  const sourceAspect = source.width / (source.height * remaining), canvasAspect = canvas.width / canvas.height;
  const byHeight = (canvas.frameFit === 'cover') === (sourceAspect > canvasAspect);
  const width = (byHeight ? 100 * sourceAspect / canvasAspect : 100) * values.videoZoom;
  const height = (byHeight ? 100 : 100 * canvasAspect / sourceAspect) * values.videoZoom;
  return {
    frame: { width: `${width}%`, height: `${height}%`, left: `${(100 - width) * values.videoPositionX / 100}%`, top: `${(100 - height) * values.videoPositionY / 100}%` },
    image: { height: `${100 / remaining}%`, top: `${-values.sourceTrimTop / remaining}%` },
  };
}
