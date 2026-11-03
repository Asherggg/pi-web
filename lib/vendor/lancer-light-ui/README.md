# Lancer Light UI provenance

Source: https://github.com/raylee-ai/lancer/tree/4dd8fe7134cd663a85f9a815ad90bb2685760da9/packages/light-ui

Pinned source commit: 4dd8fe7134cd663a85f9a815ad90bb2685760da9.

The TypeScript geometry, SVG renderer, light layer and running-border stylesheet are copied from the source package. LICENSE and NOTICE are retained alongside the code. No Lancer branding, media, avatars, Electron runtime, account manager or Pi driver is included.

Local adaptation: relative TypeScript source imports omit the emitted `.js` suffix so Next.js/Turbopack can resolve the vendored source. The renderer and its easing remain upstream code. The Pi Web integration uses Lancer's default 1200 ms flights, independent model-selector and visible-message sources, exact DOM node-dot targets, and a stable session palette shared by nodes, links and flights. New semantic message/delivery events emit; raw tool rows and loaded history remain silent. It caps visible concurrent flights at 32, follows only the work-tree scroller, and destroys the layer when the panel closes. Running message/step borders also pause when the page is hidden and honor reduced motion. Workbench module/workflow validation is adapted from Lancer's MIT contracts, with Pi Web-native storage and HTTP transport.

The behavioral reference was rechecked against upstream commit `019b2f16f746df4160f2fa9937a4e6c50c13c6f4` (`packages/light-ui/PROMPT.md` and the desktop process-curve implementation). This is an integration into Pi Web's conversation layout, not a pixel-for-pixel copy of Lancer's complete desktop shell.
