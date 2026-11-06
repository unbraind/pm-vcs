/** Cut a real staging writer at snapshot creation, payload capture or index publication. */
import { existsSync, fstatSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { objectFiles, type ObjectFile } from "../../engine/object-files.ts";
import { Repository } from "../../engine/repo.ts";
import { readWorkingFile } from "../../engine/worktree.ts";

const [root, encoded, cut, report] = process.argv.slice(2);
const paths = JSON.parse(encoded) as string[];
const repo = Repository.open(root);
let snapshot: ObjectFile | undefined; let snapshotPath: string | undefined;
const opened = objectFiles.opened;
/** Record only permission/lifetime metadata, never fixture payloads, before a fatal process cut. */
function crash(): never {
  const directory = readdirSync(repo.controlDirectory).find(name => name.startsWith("stage-"));
  const legacy = directory === undefined ? undefined : join(repo.controlDirectory, directory);
  const legacyFile = legacy === undefined ? undefined : readdirSync(legacy)[0];
  const stat = snapshot === undefined ? legacyFile === undefined ? undefined : lstatSync(join(legacy!, legacyFile)) : fstatSync(snapshot.fd);
  writeFileSync(report, JSON.stringify({
    bytes: stat?.size ?? 0, mode: stat === undefined ? null : stat.mode & 0o777,
    directoryMode: legacy === undefined ? null : lstatSync(legacy).mode & 0o777,
    named: snapshotPath === undefined ? legacy !== undefined : existsSync(snapshotPath),
    links: stat?.nlink ?? 0,
  }));
  process.kill(process.pid, "SIGKILL");
  throw new Error("Fatal cut unexpectedly returned.");
}
objectFiles.opened = (file, path) => {
  opened(file, path);
  if (dirname(path) === repo.controlDirectory && /^objects\.lock\.[0-9]+\.[0-9a-f]{12}\.tmp$/.test(basename(path))
    && objectFiles.storageOwners.has(dirname(repo.objects.storageRoot()))) {
    snapshot = file; snapshotPath = path;
    if (cut === "created") crash();
  }
};
const visits = new Set<string>();
/** The second deferred read follows the first completed snapshot write, including the prior directory-based implementation. */
const read: typeof readWorkingFile = (workingRoot, path) => {
  if (visits.has(path)) {
    if (cut === "created" && snapshot === undefined) crash();
    const captured = snapshot === undefined
      ? readdirSync(repo.controlDirectory).filter(name => name.startsWith("stage-")).some(name => readdirSync(join(repo.controlDirectory, name)).length > 0)
      : fstatSync(snapshot.fd).size > 0;
    if (cut === "written" && captured) crash();
  }
  visits.add(path); return readWorkingFile(workingRoot, path);
};
const write = repo.writeIndex.bind(repo);
if (cut === "index") repo.writeIndex = entries => { write(entries); crash(); };
process.umask(0);
repo.stage(paths, read);
throw new Error(`Snapshot crash cut ${cut} was not reached.`);
