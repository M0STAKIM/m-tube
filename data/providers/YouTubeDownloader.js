import { BaseAdapter } from './BaseAdapter.js';

/** Provider 6 — YouTube MP4/MP3 Downloader (MCP). Converter tools with enum inputs are enumerated. */
export class YouTubeDownloader extends BaseAdapter {
  platforms() { return ['youtube']; }

  keys() {
    return {
      platform: 'youtube',
      title: ['title', 'videoTitle', 'data.title', 'result.title', 'name'],
      artist: ['author', 'channel', 'uploader', 'channelTitle', 'data.author', 'result.author'],
      duration: ['duration', 'lengthSeconds', 'data.duration', 'result.duration'],
      thumbnail: ['thumbnail', 'thumbnails', 'thumb', 'data.thumbnail', 'result.thumbnail'],
      formats: ['formats', 'links', 'medias', 'downloads', 'data.formats', 'data.links', 'result.formats', 'result.links'],
      direct: ['download_url', 'downloadUrl', 'download', 'link', 'url_download', 'mp3', 'mp4', 'data.download_url', 'data.link', 'result.link', 'urls'],
    };
  }

  async resolve(url) {
    const values = { url };
    const id = BaseAdapter.youtubeId(url);
    if (id) values.id = id;
    const results = await this.mcpRun(values, ['download', 'mp3', 'mp4', 'convert', 'video', 'audio', 'info', 'get'], 4);
    return this.mergeResults(results, this.keys(), url);
  }
}
