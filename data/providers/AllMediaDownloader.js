import { BaseAdapter } from './BaseAdapter.js';

/** Provider 4 — All Media Downloader (MCP). */
export class AllMediaDownloader extends BaseAdapter {
  keys() {
    return {
      title: ['title', 'data.title', 'result.title', 'name'],
      artist: ['author', 'uploader', 'channel', 'owner', 'data.author', 'result.author'],
      duration: ['duration', 'data.duration', 'result.duration'],
      thumbnail: ['thumbnail', 'thumbnails', 'thumb', 'cover', 'data.thumbnail', 'result.thumbnail'],
      formats: ['formats', 'medias', 'links', 'downloads', 'data.formats', 'data.medias', 'result.formats', 'result.medias'],
    };
  }

  async resolve(url) {
    const results = await this.mcpRun({ url }, ['download', 'media', 'extract', 'info', 'video', 'audio', 'get'], 3);
    return this.mergeResults(results, this.keys(), url);
  }
}
