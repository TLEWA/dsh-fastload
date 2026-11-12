import fs from 'node:fs';
import path from 'node:path';

/** Lines are tiny (one per session open); rotate so a long-lived host cannot grow it. */
const MAX_BYTES = 512 * 1024;

/**
 * Always-on journal of what the host actually served for each follow request.
 *
 * This exists because an empty transcript with a "load earlier" button cannot
 * be explained from the outside: the page may have been served from the page
 * cache, replayed, dropped, or never requested at all. One line per decision
 * makes that distinction visible after a single reproduction.
 */
export function createServeLog(dir) {
  const file = path.join(dir, 'serve.log');
  let broken = false;

  function write(line) {
    if (broken) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {}
      if (size > MAX_BYTES) {
        try {
          fs.renameSync(file, file + '.1');
        } catch {
          try {
            fs.unlinkSync(file);
          } catch {}
        }
      }
      fs.appendFileSync(file, new Date().toISOString() + ' p=' + process.pid + ' ' + line + '\n');
    } catch {
      broken = true;
    }
  }

  return { file, write };
}
