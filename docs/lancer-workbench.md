# Lancer workbench in Pi Web

The Lancer workbench is embedded into the existing Pi Web conversation. Its source is adapted from `raylee-ai/lancer` commit `4dd8fe7134cd663a85f9a815ad90bb2685760da9`; the SVG light renderer and its MIT attribution live in `lib/vendor/lancer-light-ui`.

## Using it

Open a saved conversation. The row above the conversation provides **Task tree**, a module selector, and **Manage modules**.

- **Task tree** opens a docked event tree beside the conversation. On phones it opens over the conversation and has an explicit close button. Choose the current conversation, its subtask family, or the project. Read failures are isolated to a lane, with Retry. The existing full session map remains available.
- Nodes link to recorded conversation entries. Clicking an entry on the active branch scrolls to it; selecting an inactive branch uses the existing guarded tree-navigation operation. Fork uses the same guarded operation as the session map. A running conversation keeps its existing navigation restrictions.
- **Deliverables** lists files from successful coding-tool write/edit/patch results. The server checks that a file still exists inside its conversation's checkout. Opening it uses the existing file viewer and file access rules. A mentioned filename alone is not a delivery record.
- Choose a module to copy its stage template to this conversation. **Configure stages** edits this conversation's copy; **Manage modules** edits reusable templates. Template edits do not overwrite existing conversation plans. Archive and restore modules without deleting their conversation histories. Switching to ordinary chat retains the last workflow for restoration.
- Each of 1–8 stages has a title, model, selected skills, goal and deliverables. Select a stage to switch the actual model of the current Pi session. A rejected switch does not select the stage. **Load task** fills an empty composer for review; it never sends a prompt. Existing text and attachments are preserved and block loading.
- Stage selection is not task completion. Automatic stage execution and Git code merging are separate future features.
- New recorded events may emit a light toward their exact visible tree node. Loaded history is silent. Closing the tree destroys the light layer, hidden pages pause motion, and reduced-motion skips flight animation.

## Storage and compatibility

Modules and per-session workflows are auxiliary UI data in `<pi agent directory>/pi-web-workbench.json`. Writes use a revision, a per-process queue, a cross-process lock and an atomic file replacement. A concurrent stale save is rejected, and invalid existing bytes are preserved. This does not rewrite Pi session history, credentials or model settings. Browser tab state remembers whether the tree is open.

The task graph observes existing runtimes or cached read-only session managers; it does not start model sessions. Reads and rendering are bounded (40 lanes, 300 nodes per lane, 1,200 nodes overall; disk sessions above 16 MiB have an explicit unavailable lane). Internal subagent relations are supported. Third-party orchestration tools need their own data adapter to provide equivalent task status and return edges.

The embedded feature uses the existing Pi engine, model catalog, Skills, MCP, authentication, file viewer, personalization and completion sounds. No Magpie, Electron runtime or second model gateway was added.

## Verification

`node --experimental-strip-types --test --test-force-exit lib/workbench/workbench.test.mjs` tests validation, template isolation, concurrent writes, corrupt-file retention, task families, native graph edges and delivery evidence.

`node e2e/lancer-workbench.mjs` runs the actual page in Edge with isolated HTTP fixtures. It tests task-tree rendering, model handoff, draft protection, loading without sending, workflow saves, light emission and cleanup, and a 390px layout. It does not contact a model provider or establish cross-provider conversation compatibility.

The later plan milestones—automatic workflow execution, result acceptance, independent turn snapshots, scheduling, video processing and macOS desktop control—are not part of this first embedded workbench.
