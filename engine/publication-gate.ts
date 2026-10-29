/** Keep namespace durability independent of the repository stack while native publications require its real store protocol. */
import { namespacePublicationContext } from "./destruction.ts";
import { VerificationRefusal } from "./object-error.ts";
import { relative, sep } from "node:path";

/** Match Windows single-code-unit case aliases without inventing multi-character filesystem equivalences. */
function windowsCase(name: string): string { return name.replace(/[\s\S]/g, character => { const upper = character.toUpperCase(); return upper.length === 1 ? upper : character; }); }

/** Recognize only native root-bearing control destinations, never ordinary files or recovery journals. @internal */
export function nativePublicationKind(destination: string, platform: NodeJS.Platform = process.platform): string | undefined {
 const context = namespacePublicationContext(destination, platform); if (context === undefined) return undefined;
 const name = relative(context.control, context.destination).split(sep).join("/");
 const windows = platform === "win32"; const normalized = windows ? windowsCase(name) : name;
 if (normalized.startsWith(windows ? "REFS/" : "refs/")) return "ref";
 return !normalized.includes("/") ? ["HEAD", "index", "MERGE_STATE", "upload-roots.json", "denials.json"].find(key => (windows ? windowsCase(key) : key) === normalized) : undefined;
}

/** The native object layer installs its shared lease and dependency verifier once its module graph is initialized. @internal */
export interface NativePublicationGate { within<T>(destination: string, action: () => T): T; validate(source: string, destination: string): void }
let installed: NativePublicationGate | undefined;
/** Bind the actual object layer; raw namespace helpers cannot manufacture a weaker native verifier. @internal */
export function configureNativePublication(gate: NativePublicationGate): void { installed = gate; }
/** Standalone namespaces need no object adapter; a native namespace without one is explicitly unverified. */
function nativeGate(destination: string): NativePublicationGate | undefined {
 if (nativePublicationKind(destination) === undefined) return undefined;
 if (installed === undefined) throw new VerificationRefusal("publication", "store_adapter", "Open the ObjectStore or Repository SDK before publishing native control state.", "publication_unverified");
 return installed;
}
/** Acquire or verify native storage ownership before namespace publication or recovery. @internal */
export function withNativePublication<T>(destination: string, action: () => T): T { const gate = nativeGate(destination); return gate === undefined ? action() : gate.within(destination, action); }
/** Recheck dependencies through the same installed protocol immediately before rename. @internal */
export function validateNativePublication(source: string, destination: string): void { nativeGate(destination)?.validate(source, destination); }
