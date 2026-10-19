import { ChangeEvent, CSSProperties, useEffect, useRef, useState } from 'react';
import { loadTracks, saveTracks, StoredTrack } from '@/libraryStore';
import { extractMetadata } from '@/metadataExtractor';
import {
  Disc3,
  FileAudio,
  FolderOpen,
  GripVertical,
  ImagePlus,
  Menu,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  art: string;
  duration: string;
  src: string;
  local?: boolean;
  file?: File;
  artLoaded?: boolean;
  manual?: boolean;
};

const vinylCoverArt = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">' +
  '<defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#1a1a1a"/><stop offset="20%" stop-color="#0d0d0d"/><stop offset="100%" stop-color="#000"/></radialGradient></defs>' +
  '<rect width="600" height="600" fill="url(#g)"/>' +
  '<circle cx="300" cy="300" r="200" fill="none" stroke="rgba(212,175,55,0.15)" stroke-width="1"/>' +
  '<circle cx="300" cy="300" r="160" fill="none" stroke="rgba(212,175,55,0.1)" stroke-width="1"/>' +
  '<circle cx="300" cy="300" r="120" fill="none" stroke="rgba(212,175,55,0.1)" stroke-width="1"/>' +
  '<circle cx="300" cy="300" r="85" fill="#1a1a1a" stroke="#d4af37" stroke-width="2"/>' +
  '<text x="300" y="295" text-anchor="middle" fill="#d4af37" font-family="serif" font-size="24" font-weight="700">MD</text>' +
  '<text x="300" y="320" text-anchor="middle" fill="#d4af37" font-family="serif" font-size="10" letter-spacing="2">STUDIO</text>' +
  '<circle cx="300" cy="300" r="8" fill="#000" stroke="#d4af37" stroke-width="1"/>' +
  '</svg>'
);

const demoTracks: Track[] = [
  { id: 'demo-1', title: 'Main Theme', artist: 'MD Studio', album: 'Neon Rooms', art: vinylCoverArt, duration: '03:42', src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
  { id: 'demo-2', title: 'Afterglow', artist: 'Mara Vale', album: 'Neon Rooms', art: vinylCoverArt, duration: '04:18', src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
  { id: 'demo-3', title: 'Night Drive', artist: 'MD Studio', album: 'Neon Rooms', art: vinylCoverArt, duration: '03:56', src: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
];

type DirectoryHandle = FileSystemDirectoryHandle & {
  values: () => AsyncIterableIterator<FileSystemHandle>;
  queryPermission: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission: (descriptor: { mode: 'read' }) => Promise<PermissionState>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<DirectoryHandle>;
};

async function collectAudioFiles(directory: DirectoryHandle): Promise<File[]> {
  const files: File[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind === 'file' && /\.(mp3|m4a|wav|flac|ogg)$/i.test(entry.name)) {
      files.push(await (entry as FileSystemFileHandle).getFile());
    } else if (entry.kind === 'directory') {
      files.push(...await collectAudioFiles(entry as DirectoryHandle));
    }
  }
  return files;
}

function buildTrackFromFile(file: File): Track {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    title: file.name.replace(/\.[^/.]+$/, ''),
    artist: 'Artiste inconnu',
    album: 'Ma collection',
    art: vinylCoverArt,
    duration: '--:--',
    src: URL.createObjectURL(file),
    local: true,
    file,
    artLoaded: false,
  };
}

function buildTrackFromStored(item: StoredTrack): Track {
  const file = new File([item.blob], item.name, { type: item.type });
  return {
    id: item.id,
    title: item.title || item.name.replace(/\.[^/.]+$/, ''),
    artist: item.artist || 'Artiste inconnu',
    album: item.album || 'Ma collection',
    art: item.art || vinylCoverArt,
    duration: item.duration || '--:--',
    src: URL.createObjectURL(file),
    local: true,
    file,
    artLoaded: true,
  };
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) return '00:00';
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}`;
}

function App() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const artInputRef = useRef<HTMLInputElement>(null);
  const inFlightEnrichments = useRef<Set<string>>(new Set());
  const [tracks, setTracks] = useState<Track[]>(demoTracks);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.72);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [enrichStatus, setEnrichStatus] = useState<string | null>(null);

  const activeTrack = tracks[activeIndex] ?? demoTracks[0];

  const updateTrack = (id: string, updates: Partial<Track>) => {
    setTracks((currentTracks) => currentTracks.map((track) => track.id === id ? { ...track, ...updates } : track));
  };

  const enrichTrack = (track: Track) => {
    if (!track.file || track.artLoaded || track.manual || inFlightEnrichments.current.has(track.id)) return;
    inFlightEnrichments.current.add(track.id);
    setEnrichStatus(`Lecture des métadonnées…`);
    void extractMetadata(track.file).then((metadata) => {
      inFlightEnrichments.current.delete(track.id);
      const updates: Partial<Track> = { artLoaded: true };
      if (metadata.title) updates.title = metadata.title;
      if (metadata.artist) updates.artist = metadata.artist;
      if (metadata.album) updates.album = metadata.album;
      if (metadata.duration) updates.duration = metadata.duration;
      if (metadata.art) updates.art = metadata.art;
      updateTrack(track.id, updates);
      setEnrichStatus(metadata.art ? 'Pochette extraite' : 'Aucune pochette trouvée');
      persistTrackMetadata(track.id, updates);
    });
  };

  useEffect(() => {
    let cancelled = false;
    const restoreLibrary = async () => {
      try {
        const stored = await loadTracks();
        if (!stored.length || cancelled) return;
        setFolderName('Collection sauvegardée');
        const restoredTracks = stored.map((item) => buildTrackFromStored(item));
        setTracks(restoredTracks);
        setActiveIndex(0);
        setIsPlaying(false);
      } catch {
        setFolderName(null);
      }
    };
    void restoreLibrary();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (activeTrack.local && !activeTrack.artLoaded && !activeTrack.manual) {
      enrichTrack(activeTrack);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, activeTrack.id, activeTrack.artLoaded, activeTrack.manual]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = activeTrack.src;
    audio.load();
    setCurrentTime(0);
    setDuration(0);
  }, [activeTrack.src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) void audio.play().catch(() => setIsPlaying(false));
    else audio.pause();
  }, [isPlaying, activeTrack.src]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      void audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const selectTrack = (index: number) => {
    setActiveIndex(index);
    setIsPlaying(true);
  };

  const skip = (direction: 1 | -1) => {
    const nextIndex = (activeIndex + direction + tracks.length) % tracks.length;
    setActiveIndex(nextIndex);
    setIsPlaying(true);
  };

  const importFiles = async (files: File[], name: string) => {
    if (!files.length) return;
    setIsPlaying(false);
    setFolderName(name);
    const importedTracks = files.map((file) => buildTrackFromFile(file));
    setTracks(importedTracks);
    setActiveIndex(0);
    const stored: StoredTrack[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      type: file.type || 'audio/mpeg',
      size: file.size,
      blob: file,
    }));
    try {
      await saveTracks(stored);
    } catch {
      // storage optional
    }
    importedTracks.forEach((track) => enrichTrack(track));
  };

  const handleFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith('audio/') || /\.(mp3|m4a|wav|flac)$/i.test(file.name));
    void importFiles(files, 'Sélection locale');
    event.currentTarget.value = '';
  };

  const chooseDirectory = async () => {
    const picker = window as DirectoryPickerWindow;
    if (!picker.showDirectoryPicker) {
      filePickerRef.current?.click();
      return;
    }
    try {
      const handle = await picker.showDirectoryPicker();
      const permission = await handle.requestPermission({ mode: 'read' });
      if (permission !== 'granted') return;
      const files = await collectAudioFiles(handle);
      await importFiles(files, handle.name);
    } catch {
      setFolderName(null);
    }
  };

  const seek = (value: number) => {
    if (audioRef.current) audioRef.current.currentTime = value;
    setCurrentTime(value);
  };

  const persistTrackMetadata = async (id: string, updates: Partial<Track>) => {
    try {
      const stored = await loadTracks();
      const target = stored.find((item) => item.id === id);
      if (!target) return;
      if (updates.title) target.title = updates.title;
      if (updates.artist) target.artist = updates.artist;
      if (updates.album) target.album = updates.album;
      if (updates.duration) target.duration = updates.duration;
      if (updates.art && !updates.art.startsWith('blob:')) target.art = updates.art;
      await saveTracks(stored);
    } catch {
      // persistence optional
    }
  };

  const handleManualArt = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const art = URL.createObjectURL(file);
    updateTrack(activeTrack.id, { art, manual: true, artLoaded: true });
    void persistTrackMetadata(activeTrack.id, { art });
    event.currentTarget.value = '';
  };

  return (
    <main className="app-shell" style={{ '--cover': `url(${activeTrack.art})` } as CSSProperties}>
      <div className="ambient-light" />
      <audio
        ref={audioRef}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onEnded={() => skip(1)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />

      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="sidebar-header">
          <div className="brand"><Disc3 size={19} strokeWidth={1.8} /><span>MD / VINYL</span></div>
          <button className="icon-button close-sidebar" onClick={() => setSidebarOpen(false)} aria-label="Fermer le menu"><X size={18} /></button>
        </div>
        <div className="library-heading"><span>LIBRARY</span><span className="track-count">{tracks.length.toString().padStart(2, '0')}</span></div>
        <div className="track-list">
          {tracks.map((track, index) => (
            <button className={`track-row ${index === activeIndex ? 'active' : ''}`} key={`${track.title}-${index}`} onClick={() => selectTrack(index)}>
              <span className="track-number">{(index + 1).toString().padStart(2, '0')}</span>
              <img className="track-row-art" src={track.art || vinylCoverArt} alt={`Pochette de ${track.title}`} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = vinylCoverArt; }} />
              <span className="track-row-info"><strong>{track.title}</strong><small>{track.artist}</small></span>
              {index === activeIndex && <span className="equalizer"><i /><i /><i /></span>}
            </button>
          ))}
        </div>
        <div className="import-actions">
          <button type="button" className="folder-button" onClick={() => void chooseDirectory()}>
            <FolderOpen size={17} />
            <span>{folderName || 'Choisir un dossier'}</span>
          </button>
          <label className="folder-button file-button">
            <FileAudio size={17} />
            <span>Ajouter des fichiers</span>
            <input ref={filePickerRef} type="file" accept="audio/*,.mp3" multiple onChange={handleFolder} />
          </label>
        </div>
        <div className="sidebar-footer"><span>SESSION 001</span><span className="status-dot">ONLINE</span></div>
      </aside>

      {!sidebarOpen && <button className="floating-menu icon-button" onClick={() => setSidebarOpen(true)} aria-label="Ouvrir le menu"><Menu size={19} /></button>}

      <section className={`player ${sidebarOpen ? '' : 'wide'}`}>
        <header className="topbar">
          <div className="now-playing-label"><span className="live-dot" /> NOW SPINNING</div>
          <span className="collection-label">{activeTrack.local ? 'LOCAL FILES' : 'AUDIO ARCHIVE'} {enrichStatus && <span className="enrich-status">{enrichStatus}</span>} <GripVertical size={15} /></span>
        </header>

        <div className="stage">
          <div className="album-card-wrap">
            <div className="album-card">
              <img className="album-card-image" src={activeTrack.art || vinylCoverArt} alt={`Pochette de ${activeTrack.title}`} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = vinylCoverArt; }} />
              <div className="album-card-overlay"><span>MD</span><small>{activeTrack.album.toUpperCase()}</small></div>
              <button type="button" className="manual-art-button" onClick={() => artInputRef.current?.click()} aria-label="Téléverser une pochette"><ImagePlus size={16} /></button>
              <input ref={artInputRef} type="file" accept="image/*" onChange={handleManualArt} hidden />
            </div>
            <div className="card-caption"><span>01 / 03</span><span>{activeTrack.album}</span></div>
          </div>

          <div className="turntable-area">
            <div className="turntable-shadow" />
            <div className={`vinyl ${isPlaying ? 'is-playing' : ''} ${isDragging ? 'is-scratching' : ''}`} onPointerDown={() => setIsDragging(true)} onPointerUp={() => setIsDragging(false)} onPointerCancel={() => setIsDragging(false)}>
              <div className="vinyl-rings" />
              <div className="vinyl-label">
                <img className="vinyl-label-image" src={activeTrack.art || vinylCoverArt} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = vinylCoverArt; }} />
                <span>MD<br /><small>STUDIO</small></span>
              </div>
              <div className="vinyl-hole" />
            </div>
            <div className={`tonearm ${isPlaying ? 'is-playing' : ''}`}><div className="tonearm-pivot" /><div className="tonearm-bar"><div className="needle" /></div></div>
          </div>
        </div>

        <div className="player-bottom">
          <div className="track-meta"><span className="eyebrow">CURRENT RECORD</span><h1>{activeTrack.title}</h1><p>{activeTrack.artist} <b>·</b> {activeTrack.album}</p></div>
          <div className="controls-panel">
            <div className="progress-row"><span>{formatTime(currentTime)}</span><input className="seek" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(currentTime, duration || 1)} onChange={(event) => seek(Number(event.target.value))} aria-label="Position dans le morceau" /><span>{duration ? formatTime(duration) : activeTrack.duration}</span></div>
            <div className="controls-row"><button className="control-button" onClick={() => skip(-1)} aria-label="Morceau précédent"><SkipBack size={19} fill="currentColor" /></button><button className="play-button" onClick={togglePlayback} aria-label={isPlaying ? 'Pause' : 'Lecture'}>{isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</button><button className="control-button" onClick={() => skip(1)} aria-label="Morceau suivant"><SkipForward size={19} fill="currentColor" /></button><div className="volume-control"><button className="volume-icon" onClick={() => setVolume(volume > 0 ? 0 : 0.72)} aria-label="Activer ou couper le son">{volume > 0 ? <Volume2 size={17} /> : <VolumeX size={17} />}</button><input className="volume-range" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} aria-label="Volume" /></div></div>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
