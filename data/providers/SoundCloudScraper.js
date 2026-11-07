import { BaseAdapter } from './BaseAdapter.js';

/** Provider 5 — SoundCloud Scraper (MCP): search + track resolve. */
export class SoundCloudScraper extends BaseAdapter {
  platforms() { return ['soundcloud']; }

  searchKeys() {
    return {
      platform: 'soundcloud', duration_ms: true,
      list: ['collection', 'tracks', 'results', 'items', 'data'],
      title: ['title'],
      artist: ['user.username', 'artist', 'author', 'publisher_metadata.artist'],
      url: ['permalink_url', 'url', 'link'],
      thumbnail: ['artwork_url', 'thumbnail', 'user.avatar_url'],
      duration: ['duration', 'full_duration'],
    };
  }

  async search(query) {
    const items = await super.search(query);
    return items.map((i) => ({ ...i, thumbnail: i.thumbnail.replace('-large.', '-t500x500.') }));
  }

  keys() {
    return {
      platform: 'soundcloud', duration_ms: true,
      title: ['title', 'data.title', 'track.title', 'result.title'],
      artist: ['user.username', 'artist', 'author', 'uploader', 'data.user.username', 'track.user.username'],
      duration: ['duration', 'full_duration', 'data.duration', 'track.duration'],
      thumbnail: ['artwork_url', 'thumbnail', 'data.artwork_url', 'track.artwork_url', 'user.avatar_url'],
      audio: ['audio', 'audios', 'download', 'downloads', 'data.audio', 'result.audio'],
      video: [],
      formats: ['formats', 'links', 'medias', 'data.formats', 'result.formats'],
    };
  }

  async resolve(url) {
    const results = await this.mcpRun({ url }, ['download', 'track', 'audio', 'resolve', 'info', 'get'], 3);
    return this.mergeResults(results, this.keys(), url);
  }
}
