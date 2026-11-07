import { BaseAdapter } from './BaseAdapter.js';

/** Provider 7 — Spotify Music MP3 Downloader API (MCP): search + track resolve. */
export class SpotifyDownloader extends BaseAdapter {
  platforms() { return ['spotify']; }

  searchKeys() {
    return {
      platform: 'spotify', duration_ms: true,
      list: ['tracks.items', 'tracks', 'results', 'items', 'data', 'songs'],
      title: ['name', 'title'],
      artist: ['artists', 'artist', 'author'],
      url: ['external_urls.spotify', 'url', 'spotify_url', 'link'],
      thumbnail: ['album.images', 'cover', 'image', 'thumbnail', 'images'],
      duration: ['duration_ms', 'duration'],
    };
  }

  keys() {
    return {
      platform: 'spotify', duration_ms: true,
      title: ['name', 'title', 'data.title', 'data.name', 'result.title'],
      artist: ['artists', 'artist', 'author', 'data.artist', 'result.artist'],
      duration: ['duration_ms', 'duration', 'data.duration_ms', 'data.duration'],
      thumbnail: ['album.images', 'cover', 'image', 'thumbnail', 'data.cover', 'result.cover'],
      audio: ['audio', 'audios', 'download', 'downloads', 'data.audio'],
      video: [],
      formats: ['formats', 'links', 'medias', 'data.formats', 'result.formats'],
      direct: ['download_url', 'downloadUrl', 'download', 'link', 'mp3', 'data.download_url', 'data.link', 'result.link', 'urls'],
    };
  }

  async resolve(url) {
    const values = { url };
    const id = BaseAdapter.spotifyId(url);
    if (id) values.id = id;
    const results = await this.mcpRun(values, ['download', 'mp3', 'track', 'audio', 'get', 'info'], 3);
    return this.mergeResults(results, this.keys(), url);
  }
}
