# Lancer Light UI provenance

Source: https://github.com/raylee-ai/lancer/tree/4dd8fe7134cd663a85f9a815ad90bb2685760da9/packages/light-ui

Pinned source commit: 4dd8fe7134cd663a85f9a815ad90bb2685760da9.

The TypeScript geometry, SVG renderer, light layer and running-border stylesheet are copied from the source package. LICENSE and NOTICE are retained alongside the code. No Lancer branding, media, avatars, Electron runtime, account manager or Pi driver is included.

Local adaptation: relative TypeScript source imports omit the emitted `.js` suffix so Next.js/Turbopack can resolve the vendored source. Pi Web's hook limits concurrent visible flights to 8, uses existing theme colors, baselines loaded history silently, and destroys the layer when the panel closes. Workbench module/workflow validation is adapted from Lancer's MIT contracts, with Pi Web-native storage and HTTP transport.
