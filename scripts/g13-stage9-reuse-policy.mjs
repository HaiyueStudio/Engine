/** ADR 0138 is one byte-pinned acceptance case, never a general budget exemption.
 * Primary and LF checkout hashes are explicit raw byte identities, without normalization. */
export const G13_STAGE9_REUSE = Object.freeze({
  "decision": "ADR0138-selective-gui-bundle-admission",
  "sourceRun": "artifacts/engine-0.2.2/g13/windows-remaining-1793238578178-59eefefb",
  "sourceRunSha256": "a23ca3fb26f4756db766ca0d621c007685881ad744802dace7e7419201906011",
  "files": {
    "shader-language/shader-cost-budgets.json": [
      "5fe68bddd915e2251a79c528cb01bbaa8ae0b1f454d6c13ae1f03e19ce771dc7",
      "b80b9b4940339257299e9455f80273f717e0f3195905d4bf793e64285b865251"
    ],
    "shader-language/scripts/check-stage9-bundle.mjs": [
      "7d6cb64df40d043fdb5eaf0b4e6506390e1a22633d18d1601a6a9616ce979e2d"
    ]
  },
  "reports": {
    "resources": {
      "file": "artifacts/engine-0.2.1/g09/study-resources-2026-10-28T11-52-24.953Z/report.json",
      "sha256": "c78231ba3c3b7491645bd815429f2c09c2fc284f0143074e8a89f5496016435b",
      "captureRevision": "e9f257b37ac2196a7b26178e2619702d15233e34"
    },
    "rooms": {
      "file": "artifacts/engine-0.2.1/g05/continuous-rooms-2026-10-28T12-45-54.933Z/report.json",
      "sha256": "e40d32391440886a1aea899e943716ba24ff9be81a770cd0c9a617629d0610c6",
      "captureRevision": "e9f257b37ac2196a7b26178e2619702d15233e34"
    },
    "correctness": {
      "file": "artifacts/engine-0.2.1/g09/acceptance-full-2026-10-28T13-52-05.983Z/report.json",
      "sha256": "52e71431affc6b6e4a9a537ab115e5b333d2fe01eb70f019e44e84158b3a1f69",
      "captureRevision": "e9f257b37ac2196a7b26178e2619702d15233e34"
    },
    "instances": {
      "file": "artifacts/engine-0.2.1/g05/continuous-instances-2026-10-29T03-26-34.506Z/report.json",
      "sha256": "77cc4dbbdf5395e25a6911c605c5cc9b16f4eba5d20b839ef717188436372707",
      "captureRevision": "1c3735850159ecc3fbe3d8346f399dd902e2748d"
    },
    "forward": {
      "file": "artifacts/engine-0.2.1/g05/continuous-forward-2026-10-29T03-41-58.238Z/report.json",
      "sha256": "28fb5a790796d7e399411e1123ae20949545bf4ed5a751fa980c3a08ef65655f",
      "captureRevision": "1c3735850159ecc3fbe3d8346f399dd902e2748d"
    },
    "production": {
      "file": "artifacts/engine-0.2.1/g09/production-local-2026-10-29T03-45-22.427Z/report.json",
      "sha256": "944d13a6953fdd579b97e6f2137beea1960b7162f25b438bf1e5b49ab4ce07fb",
      "captureRevision": "1c3735850159ecc3fbe3d8346f399dd902e2748d"
    },
    "ablation": {
      "file": "artifacts/engine-0.2.1/g09/study-ablation-2026-10-29T04-12-03.914Z/report.json",
      "sha256": "6b374e420e71c26ba01dbf7b039e21b79d09c9f0da455b852b546daeee4f5926",
      "captureRevision": "1c3735850159ecc3fbe3d8346f399dd902e2748d"
    }
  }
});
export function isG13Stage9Binding(kind,binding){const pinned=G13_STAGE9_REUSE.reports[kind];return !!pinned&&['file','sha256','captureRevision'].every(k=>binding?.[k]===pinned[k]);}
export function validateG13Stage9Files(files){if(!Object.entries(G13_STAGE9_REUSE.files).every(([path,hashes])=>hashes.includes(files?.[path])))throw Error('ADR 0138 requires both exact approved acceptance file hashes');}
export function validateG13GateSource(run){
  if(run?.status!=='failed'||run.revision!=='1c3735850159ecc3fbe3d8346f399dd902e2748d'||run.newRendererCaptures!==196||run.reusedRendererCaptures!==384)throw Error('ADR 0138 requires the complete original failed run');
  if(Object.keys(run.reports??{}).length!==7||!Object.keys(G13_STAGE9_REUSE.reports).every(k=>isG13Stage9Binding(k,run.reports[k])))throw Error('ADR 0138 requires all seven pinned original populations');
  if(!run.error?.includes('global-gate failed')||run.externalPublishPerformed!==false||run.baselinePromoted!==false)throw Error('Original global-gate stop must be retained');
  return {status:'passed-pinned-source-only',rendererCaptures:580,newRendererCaptures:0,fullG13Complete:false};
}
