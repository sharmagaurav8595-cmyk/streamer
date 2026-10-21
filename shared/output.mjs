export const QUALITY = {
  '720p': { width: 1280, height: 720, bitrate: 4000 },
  '1080p': { width: 1920, height: 1080, bitrate: 6000 },
};

export function outputFrame(settings = {}) {
  const quality = QUALITY[settings.quality] || QUALITY['720p'];
  const vertical = settings.layout !== 'horizontal';
  return {
    width: vertical ? quality.height : quality.width,
    height: vertical ? quality.width : quality.height,
    bitrate: quality.bitrate,
    layout: vertical ? 'vertical' : 'horizontal',
    aspectRatio: vertical ? '9:16' : '16:9',
    frameFit: settings.frameFit === 'contain' ? 'contain' : 'cover',
  };
}
