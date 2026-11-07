import { BaseAdapter } from './BaseAdapter.js';

/** Provider 1 — Cloud API Hub YouTube Downloader (MCP). Tools are discovered at runtime. */
export class CloudApiHub extends BaseAdapter {
  platforms() { return ['youtube']; }

  keys() {
    return {
      platform: 'youtube',
      title: ['title', 'videoDetails.title', 'data.title', 'video.title', 'result.title'],
      artist: ['author', 'channel', 'uploader', 'channelTitle', 'videoDetails.author', 'data.author', 'result.author'],
      duration: ['duration', 'lengthSeconds', 'videoDetails.lengthSeconds', 'data.duration', 'result.duration'],
      thumbnail: ['thumbnail', 'thumbnails', 'videoDetails.thumbnail.thumbnails', 'data.thumbnail', 'result.thumbnail'],
      formats: ['formats', 'adaptiveFormats', 'medias', 'links', 'downloads', 'data.formats', 'data.links', 'result.formats', 'streamingData.formats'],
    };
  }

  async resolve(url) {
    const values = { url };
    const id = BaseAdapter.youtubeId(url);
    if (id) values.id = id;
    const results = await this.mcpRun(values, ['download', 'mp3', 'mp4', 'video', 'audio', 'info', 'get', 'media'], 3);
    return this.mergeResults(results, this.keys(), url);
  }
}
