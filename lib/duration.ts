/** Read duration from container metadata. Does not decode the whole file. */
export function readBrowserDuration(file: File, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      audio.load();
      fn();
    };
    const accept = () => {
      const duration = audio.duration;
      if (Number.isFinite(duration) && duration > 0) finish(() => resolve(duration));
    };
    const timer = window.setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) accept();
      else audio.currentTime = 1e101;
    };
    audio.ontimeupdate = () => accept();
    audio.onerror = () => finish(() => reject(new Error("metadata")));
    audio.src = url;
  });
}
