import "./helpers/isolate-session.ts";
import { registerJournalSequence } from "./helpers/journal-sequences.ts";
registerJournalSequence(import.meta.url);
