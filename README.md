# Milady Line Printer — V2 Production Candidate

A static, Vercel-compatible production candidate for `miladylineprinter.xyz`.

## What changed
- Approved scrollable newspaper-roll direction.
- Original MLP typography system retained: Georgia / Times New Roman + Courier New.
- Headline scale reduced for a more newspaper-like hierarchy.
- 620 MLPs reframed as **Operators**, not marketplace cards.
- Operator artwork is rendered **without grayscale, sepia, tint, cropping, overlays, blend modes, or CSS contrast filters**.
- Token metadata is resolved from the Ethereum contract's `tokenURI()` using public RPC fallbacks, then IPFS metadata is loaded from public gateways.
- Existing MLPIFY image-processing algorithm is preserved.
- Existing official links and contract address are preserved.
- Remilia Wire is intentionally mock data until `tpa-milady-line-printer` is approved.

## Deploy
This remains a static site.

Vercel:
- Framework preset: Other
- Install command: blank
- Build command: blank
- Output directory: `.`

## Safe rollout
1. Create a GitHub branch named `newspaper-v2`.
2. Upload `index.html`, `README.md`, and `assets/mlp-banner.jpg`.
3. Let Vercel create a preview deployment.
4. Verify Operator image accuracy, MLPIFY output, mobile behavior, and official links.
5. Merge into `main` only after review.

## Important image note
The old site applied `grayscale(.1) sepia(.08)` to NFT images. This build intentionally applies no visual filter to canonical Operator art.
