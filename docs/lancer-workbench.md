# Lancer workbench in Pi Web

The Lancer workbench is embedded into the existing Pi Web conversation. Its source is adapted from `raylee-ai/lancer` commit `4dd8fe7134cd663a85f9a815ad90bb2685760da9`; the SVG light renderer and its MIT attribution live in `lib/vendor/lancer-light-ui`.

## Using it

Open a saved conversation or a fresh composer with a project selected. The row above the conversation provides a module selector and **Manage modules**; saved conversations also provide **Task tree**.

For a fresh composer, selecting a module copies its template locally. Configure its stages, select a model and load a task before sending. Selection and editing do not create an AgentSession. On the first send, the real session is ensured, the exact workflow snapshot is saved, and only then is the prompt dispatched. A save conflict or archived module rejects the send and keeps the submitted draft recoverable. Selecting a project/worktree carries the workflow with the composer; another independent fresh composer starts with its own choice. The plan and selected stage survive a tab reload. Chat text and attachments keep Pi Web's existing page-memory draft behavior; use **Load task** again to regenerate a stage prompt after reload.

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

`node e2e/lancer-new-session.mjs` verifies fresh-composer selection, local stage edits, plan/model restoration after reload, and the exact ensure → save workflow → first prompt order with isolated HTTP fixtures.

Real provider acceptance is explicit: `LANCER_RUN_LIVE=1 node e2e/lancer-live-handoff.mjs` verifies context across two model choices through the running Pi Web HTTP API. `LANCER_RUN_LIVE=1 node e2e/lancer-live-subagents.mjs` uses an isolated agent directory, the existing subagent controller and configured credentials for two concurrent child runs, report delivery, Stop and resume. Optional `LANCER_LIVE_MODELS` selects the two `{provider, modelId}` records as a JSON array; the default acceptance pair is `ppt/gpt-6.1-sol` and `ppt/gpt-6-astra`. These commands make actual model requests and save clearly named acceptance evidence. `node e2e/lancer-reopen-results.mjs` then checks their persisted records in a fresh process without making a model request. Provider-specific thinking values and gateway availability still determine whether a selected acceptance pair can run.

Native subagent reports are projected from SDK `custom_message` entries with type `pi-web:subagent-notification`; they are not inferred from response prose.

The later plan milestones—automatic workflow execution, result acceptance, independent turn snapshots, scheduling, video processing and macOS desktop control—are not part of this first embedded workbench.
