import {G13_STAGE9_REUSE,isG13Stage9Binding,validateG13Stage9Files} from './g13-stage9-reuse-policy.mjs';
export const ENGINE_021_EVIDENCE_KINDS = Object.freeze(['correctness', 'production', 'resources', 'ablation', 'rooms', 'instances', 'forward']);

/** The seven-report contract is inherited; candidate version and evidence population are not. */
export function validateEvidenceTargetVersion(manifest, releaseVersion) {
  if(releaseVersion==='0.2.1'&&manifest.targetVersion===undefined)return;
  if(manifest.targetVersion!==releaseVersion)throw Error('Qualification target version differs from the current release candidate.');
}

/** User-approved single repair case, ADR 0129. Digests identify complete immutable populations. */
export const ENGINE_021_READBACK_REUSE = Object.freeze({
  decision: 'ADR0129-readback-cache-history',
  captureRevision: '384ad34d7007b0618cdd0408f3968d5085461130',
  sourceFiles: Object.freeze({
  "scripts/webgpu-gate/readback-churn-fixture.mjs": "6f5f5d9949121c5bfb4f2cbd93845acf70438cfd20cadafba3814a565d9a4782",
  "scripts/webgpu-gate/readback-churn-cache-history.mjs": "103863f243f1218f8fd6143ffe53a0b907be054008777403daeea19f0c6d4a3b",
  "scripts/webgpu-gate/readback-churn-contract.test.mjs": "68db10095316c7382b2a024b8aafd6d9055959b022e2b9c87203072f39aace62"
}),
  reports: Object.freeze(Object.fromEntries(Object.entries({
  "resources": {
    "file": "artifacts/engine-0.2.1/g09/study-resources-2026-10-17T01-26-17.345Z/report.json",
    "sha256": "fe4e6a7579546ef237c0a8b7b7da716028f4b275833ce204c0e863e8c960fd86"
  },
  "rooms": {
    "file": "artifacts/engine-0.2.1/g05/continuous-rooms-2026-10-17T02-15-12.689Z/report.json",
    "sha256": "155bbd1b426fa7470061581b591c7b49460d28b0eba250865b0f7e1bce9aec91"
  },
  "instances": {
    "file": "artifacts/engine-0.2.1/g05/continuous-instances-2026-10-17T03-02-39.220Z/report.json",
    "sha256": "35b76ee7dd7b3fccdf932ad0421e6cb3474ad04982c94eb4982afadba5b2e6f1"
  },
  "forward": {
    "file": "artifacts/engine-0.2.1/g05/continuous-forward-2026-10-17T03-17-41.282Z/report.json",
    "sha256": "f45d42558354f73de3e2532f9469c2d48a23f9db18e4579f5360016d4815a03a"
  },
  "production": {
    "file": "artifacts/engine-0.2.1/g09/production-local-2026-10-17T03-21-01.698Z/report.json",
    "sha256": "1a78ec905affb2c072bc3b382b96c096b0a0763da1f8625fbe857133f5ac05cd"
  },
  "ablation": {
    "file": "artifacts/engine-0.2.1/g09/study-ablation-2026-10-17T03-47-40.696Z/report.json",
    "sha256": "2ad1239926d8a6d5a2267d1b7afba8c6120784aa6de94e2704c75c7ef5c6e920"
  }
}).map(([kind, value]) => [kind, Object.freeze(value)]))),
});
/** User-approved isolated Windows PBR reference case, ADR 0130; never a generic fixture exemption. */
export const ENGINE_021_PBR_REUSE = Object.freeze({
  decision: 'ADR0130-pbr-windows-reference',
  sourceFiles: Object.freeze({
  "scripts/verify-pbr-example.mjs": "dc554daf0283bc780f7c17940bef5e269bb3733bdf71df7d03708bb853352580",
  "scripts/pbr-example-pixel-policy.mjs": "a5a6812e42409d9716261b56d0cb72b8994f848bd781d8b9b7c3e99c8f38e37d",
  "scripts/pbr-example-pixel-policy.test.mjs": "8725c333f3bc99afd26b57e0f2a1596346f4c2f17884b2522a8739c729d0477f",
  "review/baselines/render-pixels-stage9-pbr-example.win32.json": "79da741390ae3516bcd4a7fb19bec47386e0394efb9625040c4605fc3593bb64"
}),
  reports: Object.freeze(Object.fromEntries(Object.entries({
  "resources": {
    "file": "artifacts/engine-0.2.1/g09/study-resources-2026-10-17T01-26-17.345Z/report.json",
    "sha256": "fe4e6a7579546ef237c0a8b7b7da716028f4b275833ce204c0e863e8c960fd86",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "rooms": {
    "file": "artifacts/engine-0.2.1/g05/continuous-rooms-2026-10-17T02-15-12.689Z/report.json",
    "sha256": "155bbd1b426fa7470061581b591c7b49460d28b0eba250865b0f7e1bce9aec91",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "instances": {
    "file": "artifacts/engine-0.2.1/g05/continuous-instances-2026-10-17T03-02-39.220Z/report.json",
    "sha256": "35b76ee7dd7b3fccdf932ad0421e6cb3474ad04982c94eb4982afadba5b2e6f1",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "forward": {
    "file": "artifacts/engine-0.2.1/g05/continuous-forward-2026-10-17T03-17-41.282Z/report.json",
    "sha256": "f45d42558354f73de3e2532f9469c2d48a23f9db18e4579f5360016d4815a03a",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "production": {
    "file": "artifacts/engine-0.2.1/g09/production-local-2026-10-17T03-21-01.698Z/report.json",
    "sha256": "1a78ec905affb2c072bc3b382b96c096b0a0763da1f8625fbe857133f5ac05cd",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "ablation": {
    "file": "artifacts/engine-0.2.1/g09/study-ablation-2026-10-17T03-47-40.696Z/report.json",
    "sha256": "2ad1239926d8a6d5a2267d1b7afba8c6120784aa6de94e2704c75c7ef5c6e920",
    "captureRevision": "384ad34d7007b0618cdd0408f3968d5085461130"
  },
  "correctness": {
    "file": "artifacts/engine-0.2.1/g09/acceptance-full-2026-10-17T05-32-37.989Z/report.json",
    "sha256": "5011f738c412e25fff19694cd71a8fb5448c3f13b8d068ff045ea9fccb36194b",
    "captureRevision": "1260d9b521b19c686794ad2f92056fe47662fb5a"
  }
}).map(([kind, value]) => [kind, Object.freeze(value)]))),
});
/** User-approved isolated FrameGraph download-context case, ADR 0131. Population pins are unchanged. */
export const ENGINE_021_DOWNLOAD_REUSE = Object.freeze({
  decision: 'ADR0131-framegraph-download-context',
  sourceFiles: Object.freeze({
  "scripts/verify-framegraph-example.mjs": "b526aad50f726c30522d1a5101f334dd44c5b0cf6122c969ce46e6e11e87ebee",
  "scripts/framegraph-example-download-policy.mjs": "8ed758c5835725af67fa0310e8f194eaa27e18aeec7b5f154534528023c62490",
  "scripts/framegraph-example-download-policy.test.mjs": "c4956990e38f73dfb29d6563abe2874fc9f7bcb767c4d03ab4ed31c579b1c20f"
}),
  reports: ENGINE_021_PBR_REUSE.reports,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (condition, message) => { if (!condition) throw Error(message); };
const g05Kinds = ['rooms', 'instances', 'forward'];
const policyFiles = new Set(['scripts/engine-021-evidence-policy.mjs', 'scripts/engine-021-evidence-policy.test.mjs',
  'scripts/check-engine-021-evidence.mjs']);
// ADR 0137 names interpretation/receipt files only; none is a measurement input.
const engine022AcceptanceFiles = new Set(['scripts/g13-windows-final-policy.mjs',
  'scripts/g13-windows-final-policy.test.mjs', 'review/engine-0.2.2/g13-checks.json',
  'scripts/g13-windows-remaining-policy.mjs','scripts/run-g13-windows-remaining.mjs',
  'scripts/start-g13-windows-remaining.cmd','scripts/start-g13-windows-remaining.ps1',
  'config/g13-windows-remaining.json','scripts/g13-stage9-reuse-policy.mjs',
  'scripts/run-g13-windows-gates.mjs','scripts/start-g13-windows-gates.cmd',
  'scripts/start-g13-windows-gates.ps1','scripts/stage9-selective-bundle.test.mjs']);

export function isEngine021ReadbackReuseBinding(kind, binding) {
  const pinned = ENGINE_021_READBACK_REUSE.reports[kind];
  return !!pinned && binding?.captureRevision === ENGINE_021_READBACK_REUSE.captureRevision &&
    binding.file === pinned.file && binding.sha256 === pinned.sha256;
}

export function isEngine021PbrReuseBinding(kind, binding) {
  const pinned = ENGINE_021_PBR_REUSE.reports[kind];
  return !!pinned && binding?.captureRevision === pinned.captureRevision && binding.file === pinned.file && binding.sha256 === pinned.sha256;
}

const safePath = path => typeof path === 'string' && !path.split('/').some(p => !p || p === '..' || p === '.') && !path.includes('\\');
const acceptancePath = path => safePath(path) && (policyFiles.has(path) || ['README.md', 'CHANGELOG.md'].includes(path) || /^(docs|review)\/.+\.md$/.test(path));

/** ADR 0126 remains the default; ADRs 0129–0131 are separate, byte-pinned repair cases. */
export function validateEngine021RevisionReuse(captureRevision, current, kind, binding, reuseDecision) {
  check(/^[a-f0-9]{40}$/.test(captureRevision), 'Missing clean capture revision');
  if ([ENGINE_021_PBR_REUSE.decision, ENGINE_021_DOWNLOAD_REUSE.decision].includes(reuseDecision)) {
    check(captureRevision !== current.revision && isEngine021PbrReuseBinding(kind, binding),
      'ADR 0130 requires its exact seven pinned populations');
    const paths = current.reuseChanges?.[captureRevision];
    check(Array.isArray(paths), 'ADR 0130 requires a verified Git comparison for every capture revision');
    const fixedFiles = Object.entries(ENGINE_021_PBR_REUSE.sourceFiles);
    check(fixedFiles.every(([path, hash]) => paths.includes(path) && current.pbrFixFiles?.[path] === hash),
      'ADR 0130 requires the exact reviewed PBR repair and Windows reference bytes');
    const downloadFiles = reuseDecision === ENGINE_021_DOWNLOAD_REUSE.decision ? Object.entries(ENGINE_021_DOWNLOAD_REUSE.sourceFiles) : [];
    check(downloadFiles.every(([path, hash]) => paths.includes(path) && current.downloadFixFiles?.[path] === hash),
      'ADR 0131 requires the exact reviewed isolated download-context repair bytes');
    const readbackFiles = Object.entries(ENGINE_021_READBACK_REUSE.sourceFiles);
    check(readbackFiles.every(([path, hash]) => current.readbackFixFiles?.[path] === hash),
      'ADR 0130 retains the exact ADR 0129 readback repair');
    const originalSix = captureRevision === ENGINE_021_READBACK_REUSE.captureRevision;
    if (originalSix) check(readbackFiles.every(([path]) => paths.includes(path)), 'ADR 0130 original six require the readback repair comparison');
    const allowed = new Set([...fixedFiles.map(([path]) => path), ...downloadFiles.map(([path]) => path), ...(originalSix ? readbackFiles.map(([path]) => path) : []),
      'scripts/engine-021-candidate-policy.mjs', 'scripts/engine-021-candidate-policy.test.mjs',
      'review/engine-0.2.1/release-candidate.json']);
    check(paths.every(path => acceptancePath(path) || safePath(path) && allowed.has(path)),
      'ADR 0130 requires new sampling after another non-acceptance change');
    return;
  }
  if (captureRevision === current.revision) return;
  const paths = current.reuseChanges?.[captureRevision];
  check(Array.isArray(paths), 'Missing verified Git comparison for capture revision');
  if (paths.every(path => acceptancePath(path) || current.targetVersion === '0.2.2'
    && safePath(path) && engine022AcceptanceFiles.has(path))) return;
  if(current.targetVersion==='0.2.2'&&isG13Stage9Binding(kind,binding)&&binding.captureRevision===captureRevision
    &&paths.every(path=>acceptancePath(path)||safePath(path)&&(engine022AcceptanceFiles.has(path)||Object.hasOwn(G13_STAGE9_REUSE.files,path)))){
    validateG13Stage9Files(current.stage9FixFiles);return;
  }
  check(captureRevision === ENGINE_021_READBACK_REUSE.captureRevision && isEngine021ReadbackReuseBinding(kind, binding),
    'Evidence reuse requires new sampling after non-acceptance change; this is not an ADR 0129 pinned population');
  check(reuseDecision === ENGINE_021_READBACK_REUSE.decision, 'ADR 0129 requires its explicit manifest decision');
  const fixedFiles = Object.entries(ENGINE_021_READBACK_REUSE.sourceFiles);
  check(fixedFiles.every(([path, hash]) => paths.includes(path) && current.readbackFixFiles?.[path] === hash),
    'ADR 0129 requires the exact reviewed readback repair bytes');
  const allowed = new Set([...fixedFiles.map(([path]) => path),
    'scripts/engine-021-candidate-policy.mjs', 'scripts/engine-021-candidate-policy.test.mjs',
    'review/engine-0.2.1/release-candidate.json']);
  check(paths.every(path => acceptancePath(path) || safePath(path) && allowed.has(path)),
    'Evidence reuse requires new sampling after another non-acceptance change');
}

/** One user-approved documentation repair. Original 0.2.4 populations remain immutable. */
export const ENGINE_024_CHANGELOG_REUSE = Object.freeze({
  "decision": "g07-024-changelog-heading-20261119",
  "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a",
  "changelogLfSha256": "40cfa59fbadd0c9b4e8ef290e9b3d6d4e5ccc7d9723c234e37e947e5992af768",
  "allowedChanges": [
    "CHANGELOG.md",
    "scripts/check-engine-021-evidence.mjs",
    "scripts/engine-021-evidence-policy.mjs",
    "scripts/engine-021-evidence-policy.test.mjs"
  ],
  "reports": {
    "resources": {
      "file": "artifacts/engine-0.2.1/g09/study-resources-2026-11-18T14-21-13.374Z/report.json",
      "sha256": "eecf351a92b56d1181de056431012c1338c8a03a0cbd3e5bd9f260a450e6b2e6",
      "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a"
    },
    "rooms": {
      "file": "artifacts/engine-0.2.1/g05/continuous-rooms-2026-11-18T14-42-27.840Z/report.json",
      "sha256": "0f3f66013523eac9295f8b6fab525d43eb0843beaa0087c17fc3b5f17ba41481",
      "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a"
    },
    "instances": {
      "file": "artifacts/engine-0.2.1/g05/continuous-instances-2026-11-18T15-30-27.063Z/report.json",
      "sha256": "8dfd1450a9a58bdee5b71a56cd750e4ad24f2793ce79ab19a2824a73d9495446",
      "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a"
    },
    "forward": {
      "file": "artifacts/engine-0.2.1/g05/continuous-forward-2026-11-18T15-45-45.512Z/report.json",
      "sha256": "4ef6c742e7eda0b2f44effabf0fabdcac2de4ba34bec86e189f78dae784c2abe",
      "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a"
    },
    "production": {
      "file": "artifacts/engine-0.2.1/g09/production-local-2026-11-18T15-49-00.685Z/report.json",
      "sha256": "fea3b985457822a7ee5f577b2c4c3f463e6d2272413ba5674aa32190cc9c1c70",
      "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a"
    },
    "ablation": {
      "file": "artifacts/engine-0.2.1/g09/study-ablation-2026-11-18T16-15-39.524Z/report.json",
      "sha256": "1d97e1ef4263869ee86c8438ee524c0f79bab0b8604a1a44937328be8c578d84",
      "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a"
    },
    "correctness": {
      "file": "artifacts/engine-0.2.1/g09/acceptance-full-2026-11-18T16-27-58.685Z/report.json",
      "sha256": "3ec2ead262b3342a71b14ef9a92e424d206eb0cf0b67035466b5100b91d721e1",
      "captureRevision": "f204b9b96f73677f56e71c50546161ae7f0eb45a"
    }
  },
  "production": {
    "file": "artifacts/engine-0.2.4/g07/qualification-f204b9b/device-kit/performance/formal-IvNSxx/result.json",
    "sha256": "8f4fb821ab0670c48ecad9c3ef23d965616ccc05581f34b7e4cd5f513e56fb20",
    "rows": [
      {
        "id": "static-dialogue",
        "processIndex": 1,
        "path": "static-dialogue-1.json",
        "sha256": "392cce1cb51f60929bff0ab7777223d4265f30999fee31486d8ffddbc8f32b6c"
      },
      {
        "id": "static-dialogue",
        "processIndex": 2,
        "path": "static-dialogue-2.json",
        "sha256": "108c5d71674b486533ce25515d9d2caf7d901a06f06f69640e58f3e97289b263"
      },
      {
        "id": "static-dialogue",
        "processIndex": 3,
        "path": "static-dialogue-3.json",
        "sha256": "c411c4abfd72b80fef2e7e8c7e7a3e7c508ed8196015e6aef0d6904cfeffef33"
      },
      {
        "id": "continuous-background",
        "processIndex": 1,
        "path": "continuous-background-1.json",
        "sha256": "ba459a5657b3dc0b7684594b77810d9d0dce97ac523ec71dbf47c342b4cb5249"
      },
      {
        "id": "continuous-background",
        "processIndex": 2,
        "path": "continuous-background-2.json",
        "sha256": "7f561aebbf2af12d57ad1a906ce76ee27d45481d58421b35df734f3524ca2a17"
      },
      {
        "id": "continuous-background",
        "processIndex": 3,
        "path": "continuous-background-3.json",
        "sha256": "82e994176a54803a148eb930bcfab5c1f4885e1ff7429a5f939a61ebc6cee40b"
      },
      {
        "id": "two-actors-and-effect",
        "processIndex": 1,
        "path": "two-actors-and-effect-1.json",
        "sha256": "e9344f3ea1f85d462e4624cd7b0bc0a73861eca642666861cb4d51688e4d7ec2"
      },
      {
        "id": "two-actors-and-effect",
        "processIndex": 2,
        "path": "two-actors-and-effect-2.json",
        "sha256": "b1b64ef11cd1bc281e91666aefa37d400595a4c555c9ca46b001d373d568e5b8"
      },
      {
        "id": "two-actors-and-effect",
        "processIndex": 3,
        "path": "two-actors-and-effect-3.json",
        "sha256": "f2e0c4f8a403fc8720115dc1d9aa6191dd106e817d1d5be352bfc893f6b15dc8"
      },
      {
        "id": "prepared-shot-switch",
        "processIndex": 1,
        "path": "prepared-shot-switch-1.json",
        "sha256": "ac5b39ea7a20940f73e73c293283cd465f47a6faf0bda3e9e6d47a1baf2cff9d"
      },
      {
        "id": "prepared-shot-switch",
        "processIndex": 2,
        "path": "prepared-shot-switch-2.json",
        "sha256": "55d57a567f94c8c2cadc1adedd41fcce8daac2ec0dde5f2a90ac40194c1b75b1"
      },
      {
        "id": "prepared-shot-switch",
        "processIndex": 3,
        "path": "prepared-shot-switch-3.json",
        "sha256": "ae17162f5a6844c943ea025cd2fa07d2ab53f4b5b60c3952d916864872da3f37"
      },
      {
        "id": "repeated-resume",
        "processIndex": 1,
        "path": "repeated-resume-1.json",
        "sha256": "9ff4020f1823e9e55bf4973da189d942e9c996a6acde3f8970ee1c436809dc68"
      },
      {
        "id": "repeated-resume",
        "processIndex": 2,
        "path": "repeated-resume-2.json",
        "sha256": "e27669f0341814005dfcb2133cac6698a65bf9a93766e3ae48313733c3e36ac1"
      },
      {
        "id": "repeated-resume",
        "processIndex": 3,
        "path": "repeated-resume-3.json",
        "sha256": "636893dfffb9f2f030324c9841cd679fd36354c70dfe62b7de00ca303059e6f6"
      }
    ],
    "rebuiltKit": "artifacts/engine-0.2.4/g07/changelog-reuse/production-rebuild/device-kit",
    "files": {
      "bundle.js": "49b19c3f20f079c112e2f365c5a04a45b0f979a4f83ac8b00ff86d8ff48e8f69",
      "index.html": "2934452a5581c0a251983881a898ff1e000e2666b2da8ee0d2249403e719b745",
      "physical.mjs": "03930b5f94c0a6f23d503460655dddf47b18e8603147c068a939aaa6aa57867b",
      "project/assets/arrival-en.wav": "f2df9cb90dd420d8cdac6bc88a33dc328195807de36c9cf1ca68f59bd3b2fd50",
      "project/assets/arrival-zh.wav": "0f314e6031f5e1b334b213f7b261bebc192ff43706ba6a0b66a01efd4f1c5bf0",
      "project/assets/harbor-loop.wav": "ba8a0775a31ff38523ded49540d47aeb767509eb5e304d8af59bad273b40b89f",
      "project/assets/harbor.hya.json": "b91b35548403726db1a4e67bc8614f1836e5eb5ac646eba7480eef584d67a341",
      "project/assets/keeper.hya.json": "c8868f446b17d5635d4217c1e17a0dc75026dd47ed9b9e7ade5eb2790dcd26c6",
      "project/assets/lantern-en.wav": "f31d3c0cac290aa2fb6582eb7baadf26e1ad74c06908e987f620dcf1c705b5cb",
      "project/assets/lantern-zh.wav": "c09c011dcfbc136e46b53dfe9333979ecb39201fb4d7ccdaed88dca961f40f63",
      "project/assets/pier-en.wav": "ff8a40f319123d729c78a8317a17fe54079863b4c37926887fa9ce6076a6a535",
      "project/assets/pier-zh.wav": "7d6f2489791ab6cb8c67288df758db3415db4bb93aae75e53579b1e14ae9d8f6",
      "project/assets/rain.hya.json": "93379249e978ef2d023b4cf33593d7fdf561287b42c3aa8b9b952e8376d51baf",
      "project/assets/signal.hya.json": "4a5fa3dc993c7015ca95aa3eb9ee107784b7d5ff1f3a07cb8ed71d1170e99efb",
      "project/assets/tide-en.wav": "19f401e790df79a51e9b301d914f3bbd39537fbca83f94681de538f486fedf77",
      "project/assets/tide-zh.wav": "e25fcbb2b600efaf8a3bed742810777163f965fc731118da6b66a7e389467b49",
      "project/assets/traveler.hya.json": "9446a864ca3c82fbdf5ab45cdbf663cd4d227c609813278dd51a03708db9ab02",
      "project/compiled.json": "fbcc5f40cdb2211aab663422dd6a498cfe42b9b04c86f777a750799b558984b6",
      "style.css": "cc088fb923f691732381fc1511d838e8ca18f97f924aff2bd6a1ffbf1e1c295e"
    }
  }
});

export function validateEngine024ChangelogReuse(manifest, current) {
  const pin = ENGINE_024_CHANGELOG_REUSE;
  check(current.targetVersion === '0.2.4' && manifest.targetVersion === '0.2.4'
    && manifest.changelogReuseDecision === pin.decision, 'Unknown 0.2.4 changelog reuse decision');
  check(current.revision !== pin.captureRevision && current.dirty === false, 'Changelog reuse requires a new clean acceptance revision');
  check(current.changelogLfSha256 === pin.changelogLfSha256, 'Changelog differs from the approved heading-only repair');
  const paths = current.reuseChanges?.[pin.captureRevision];
  check(Array.isArray(paths) && same(paths.toSorted(), pin.allowedChanges), 'Changelog reuse includes another source change');
  check(same(Object.keys(manifest.reports ?? {}).sort(), Object.keys(pin.reports).sort())
    && Object.entries(pin.reports).every(([kind, binding]) =>
      Object.entries(binding).every(([key, value]) => manifest.reports[kind]?.[key] === value)),
    'Changelog reuse requires all seven exact pinned reports');
  return { decision: pin.decision, captureRevision: pin.captureRevision, acceptanceRevision: current.revision, changes: paths };
}

export function validateEngine024ProductionReuse(summary, records) {
  const pin = ENGINE_024_CHANGELOG_REUSE;
  check(summary?.status === 'passed' && summary.revision === pin.captureRevision, 'Production reuse requires its original passed capture');
  check(Array.isArray(summary.rows) && summary.rows.length === pin.production.rows.length
    && Array.isArray(records) && records.length === pin.production.rows.length, 'Production reuse requires all fifteen processes');
  const seen = new Set();
  for (const expected of pin.production.rows) {
    const row = summary.rows.find(item => item.id === expected.id && item.processIndex === expected.processIndex);
    const record = records.find(item => item.file === expected.path);
    check(row && Object.entries(expected).every(([key, value]) => row[key] === value)
      && record?.sha256 === expected.sha256 && !seen.has(record.file), 'Production reuse raw identity differs');
    seen.add(record.file);
    const raw = record.raw;
    check(raw?.revision === pin.captureRevision && raw.scenario === expected.id, 'Production reuse capture revision differs');
    check(raw.browserEvidence?.nativeBackend === true && raw.browserEvidence.presentationMode === 'visible-window'
      && !/HeadlessChrome/.test(raw.browserEvidence.userAgent), 'Production reuse requires visible native WebGPU');
    check(Array.isArray(raw.rows) && raw.rows.length >= 180 && raw.rows.every(row => row.cachedRegions <= 8
      && row.retainedColorBytes <= 64 * 1024 * 1024), 'Production reuse cache or sample contract failed');
    check(Array.isArray(raw.gpuFrames) && (raw.scenario === 'static-dialogue' ? raw.gpuFrames.length === 0 : raw.gpuFrames.length >= 30),
      'Production reuse GPU population incomplete');
    check(Array.isArray(raw.gpuErrors) && raw.gpuErrors.length === 0 && raw.final?.releasedOwnerResiduals === 0
      && raw.retired?.releasedOwnerResiduals === 0, 'Production reuse GPU errors or owner residual');
    check(['voices', 'buffers', 'audioNodes'].every(key => raw.audioAfterDispose?.[key] === 0), 'Production reuse audio residual');
  }
  return { status: 'passed', captureRevision: pin.captureRevision, processes: records.length };
}
/** Identity checks precede independent raw-artifact audits; summary status alone never qualifies a bundle. */
export function validateEngine021EvidenceBindings(manifest, reports, current) {
  check(manifest?.schemaVersion === 2 && manifest.contractId === 'engine-021-evidence-v2', 'Unknown qualification manifest');
  if (current.targetVersion !== undefined) validateEvidenceTargetVersion(manifest, current.targetVersion);
  check(manifest.reuseDecision === undefined || [ENGINE_021_READBACK_REUSE.decision, ENGINE_021_PBR_REUSE.decision, ENGINE_021_DOWNLOAD_REUSE.decision].includes(manifest.reuseDecision), 'Unknown evidence reuse decision');
  check(/^[a-f0-9]{40}$/.test(current.revision) && current.dirty === false && manifest.revision === current.revision,
    'Qualification requires the current clean revision');
  if (manifest.changelogReuseDecision !== undefined) validateEngine024ChangelogReuse(manifest, current);
  check(same(Object.keys(manifest.reports ?? {}).sort(), [...ENGINE_021_EVIDENCE_KINDS].sort()) &&
    same(Object.keys(reports).sort(), [...ENGINE_021_EVIDENCE_KINDS].sort()), 'All seven complete reports are required');
  const paths = new Set(), hosts = new Set();
  for (const kind of ENGINE_021_EVIDENCE_KINDS) {
    const binding = manifest.reports[kind], report = reports[kind];
    check(typeof binding?.file === 'string' && binding.file.startsWith('artifacts/') && !binding.file.split('/').some(p => !p || p === '..' || p === '.') &&
      !binding.file.includes('\\') && /^[a-f0-9]{64}$/.test(binding.sha256) && !paths.has(binding.file), `Invalid/duplicate ${kind} report binding`);
    paths.add(binding.file);
    check(binding.captureRevision === report?.revision && report.dirty === false &&
      (report.status === 'passed' || g05Kinds.includes(kind) && report.status === 'failed'), `${kind}: not a complete clean capture`);
    if (current.targetVersion === '0.2.4') check(report.revision === current.revision || manifest.changelogReuseDecision === ENGINE_024_CHANGELOG_REUSE.decision,
      kind + ': 0.2.4 requires fresh candidate evidence');
    validateEngine021RevisionReuse(report.revision, current, kind, binding, manifest.reuseDecision);
    check(Number.isFinite(Date.parse(report.generatedAt)) && Number.isFinite(Date.parse(report.finishedAt)) &&
      Date.parse(report.finishedAt) >= Date.parse(report.generatedAt), `${kind}: missing capture completion`);
    if (kind === 'correctness') {
      check(report.tier === 'full' && same(report.inputs, current.runtime), 'Correctness inputs/tier differ');
      check(report.baseline?.revision === current.framegraphBaselineRevision, 'Incorrect FrameGraph baseline');
      check(same(report.qualification, current.qualification), 'Correctness qualification path/host differs');
      hosts.add(report.qualification.hostname);
    } else {
      const continuous = ['rooms', 'instances', 'forward'].includes(kind);
      check(report.tier === (kind === 'production' ? 'production-local' : 'local-full'), `${kind}: smoke/diagnostic tier cannot qualify`);
      check(same(report.config, continuous ? current.lightingConfig : current.productionConfig), `${kind}: current config differs`);
      check(same(report.inputs, current.inputs[kind]), `${kind}: current runtime/harness differs`);
      if (continuous) check(report.suite === kind, `${kind}: wrong continuous suite`);
      if (kind === 'resources' || kind === 'ablation') check(report.mode === kind, `${kind}: wrong study mode`);
      const host = continuous ? report.hostBefore : report.host;
      check(typeof host?.hostname === 'string' && host.hostname.length > 0, `${kind}: missing host identity`);
      hosts.add(host.hostname);
    }
  }
  check(hosts.size === 1, 'Evidence must come from the same host');
}

/** Compare every emitted candidate chunk to a fresh build under the acceptance revision. */
export function validateEngine021CompiledEvidence(reports, builds) {
  const normalize = files => {
    check(Array.isArray(files) && files.some(f => f.file === 'fixture.js') && new Set(files.map(f => f.file)).size === files.length,
      'Missing/duplicate compiled candidate chunks');
    check(files.every(f => typeof f.file === 'string' && /^[a-f0-9]{64}$/.test(f.sha256)), 'Invalid compiled chunk digest');
    return files.map(({ file, sha256 }) => ({ file, sha256 })).sort((a, b) => a.file.localeCompare(b.file));
  };
  for (const kind of ENGINE_021_EVIDENCE_KINDS) {
    const captured = kind === 'correctness' ? reports[kind]?.build?.outputs : reports[kind]?.build;
    const rebuilt = builds[g05Kinds.includes(kind) || kind === 'correctness' ? 'common' : kind];
    check(same(normalize(captured), normalize(rebuilt)), `${kind}: rebuilt candidate bytes differ; new sampling required`);
  }
}

export const ENGINE_022_SPARSE256_CPU_DECISION = 'ADR0137-g05-moving-sparse256-cpu-investigation';

function isMovingSparse256CpuCheck(kind, c, targetVersion) {
  const job = c.job;
  return ['0.2.2', '0.2.3', '0.2.4'].includes(targetVersion) && kind === 'rooms' && c.metric === 'cpuP95Ms' && c.limit === 4
    && job?.suite === 'rooms' && job.caseId === 'sparse-256' && job.moving === true && job.algorithm === 'tiled'
    && ['chrome-windows', 'edge-windows'].includes(job.browserId) && job.preference === 'high-performance'
    && job.full === true && job.idleMs === 0 && job.cohort === 0;
}

/** Consume only a complete independent raw audit; original measurement status remains unchanged. */
export function assessEngine021G05Audit(kind, audit, targetVersion = '0.2.1') {
  check(['0.2.1', '0.2.2', '0.2.3', '0.2.4'].includes(targetVersion), 'Unknown G05 acceptance target version');
  const shape = { rooms: [156, 60, 156, 156], instances: [96, 96, 192, 0], forward: [24, 8, 16, 0] }[kind];
  check(shape && ['passed', 'failed'].includes(audit?.status) && audit.cleanCandidate === true && audit.captures === shape[0] &&
    audit.checks?.length === shape[1] && audit.stability?.length === shape[2] && audit.memory?.length === shape[3],
    `${kind}: incomplete independent G05 audit`);
  const cpuRegressionInvestigations = [];
  const cpuAbsoluteInvestigations = [], roomCpuBrowsers = new Set();
  for (const c of audit.checks) {
    check(Number.isFinite(c.observed) && c.observed >= 0 && Number.isFinite(c.limit) && c.limit > 0 &&
      c.passed === (c.observed <= c.limit) && (kind !== 'forward' || c.limit === 1.05),
      `${kind}: invalid original performance budget evidence`);
    if (kind === 'forward') check(['cpuP95Ratio', 'gpuP95Ratio'].includes(c.metric), 'forward: unknown timing metric');
    // ADR 0127 changes only interpretation of Forward CPU relative excess. The
    // original 1.05 line, measured values and failed checks remain in the audit.
    if (kind === 'forward' && c.metric === 'cpuP95Ratio') {
      if (!c.passed) cpuRegressionInvestigations.push(c);
    } else if (isMovingSparse256CpuCheck(kind, c, targetVersion)) {
      check(!roomCpuBrowsers.has(c.job.browserId), 'rooms: duplicate dynamic sparse-256 CPU check');
      roomCpuBrowsers.add(c.job.browserId);
      if (!c.passed) cpuAbsoluteInvestigations.push(c);
    } else check(c.passed, `${kind}: original performance budget failed`);
  }
  if (kind === 'forward') check(audit.checks.filter(c => c.metric === 'cpuP95Ratio').length === 4 &&
    audit.checks.filter(c => c.metric === 'gpuP95Ratio').length === 4, 'forward: incomplete CPU/GPU coverage');
  if (['0.2.2', '0.2.3', '0.2.4'].includes(targetVersion) && kind === 'rooms') check(roomCpuBrowsers.size === 2,
    'rooms: complete dynamic sparse-256 CPU browser coverage required');
  for (const m of audit.memory) check(m.status === 'passed' && m.checks?.length > 0 && m.checks.every(c =>
    c.passed === true && Number.isFinite(c.observed) && c.observed >= 0 && Number.isFinite(c.limit) && c.limit > 0 && c.observed <= c.limit),
    `${kind}: original resource budget failed`);
  for (const s of audit.stability) check(typeof s.stable === 'boolean' && s.passed === s.stable &&
    s.cohortP95?.length === 3 && s.cohortP95.every(n => Number.isFinite(n) && n > 0) &&
    Number.isFinite(s.relativeSpread) && s.relativeSpread >= 0 && Number.isFinite(s.cv) && s.cv >= 0,
    `${kind}: incomplete stability evidence`);
  const warnings = audit.stability.filter(s => !s.stable);
  check(audit.status === (warnings.length || cpuRegressionInvestigations.length || cpuAbsoluteInvestigations.length ? 'failed' : 'passed'), `${kind}: inconsistent original audit status`);
  return { status: 'passed', originalStatus: audit.status, performanceChecks: audit.checks.length,
    hardPerformanceChecks: kind === 'forward' ? 4 : audit.checks.length - roomCpuBrowsers.size,
    stabilityChecks: audit.stability.length, warnings, cpuRegressionInvestigations, cpuAbsoluteInvestigations,
    ...(['0.2.2', '0.2.3', '0.2.4'].includes(targetVersion) && kind === 'rooms' ? { acceptanceDecision: ENGINE_022_SPARSE256_CPU_DECISION } : {}),
    scope: 'ADR 0126/0127 prerequisite only. Cohort variation and Forward CPU 5% excess are investigated. '
      + (['0.2.2', '0.2.3', '0.2.4'].includes(targetVersion) ? 'ADR 0137 additionally investigates only Windows moving tiled sparse-256 CPU 4 ms; Later admitted target versions keep this exact scope. ' : '')
      + 'GPU 5%, other budgets, complete production, resources, correctness and release evidence remain required.' };
}

export function completeEngine021EvidenceAudit(audits, reports, targetVersion = '0.2.1') {
  check(same(Object.keys(audits).sort(), [...ENGINE_021_EVIDENCE_KINDS].sort()), 'Missing raw-artifact audit');
  const assessments = {};
  for (const kind of ENGINE_021_EVIDENCE_KINDS) {
    if (g05Kinds.includes(kind)) {
      check(reports?.[kind]?.status === audits[kind]?.status, `${kind}: stored and recalculated original status differ`);
      assessments[kind] = assessEngine021G05Audit(kind, audits[kind], targetVersion);
    } else check(audits[kind]?.status === 'passed', `${kind}: independent raw-artifact audit did not pass`);
  }
  return { status: 'passed', audited: [...ENGINE_021_EVIDENCE_KINDS], assessments, g09Complete: false, releaseQualified: false,
    scope: 'Hash-matched candidate correctness, presented pacing, sustained resources, attribution and G05 timing prerequisites only; lifecycle, Shader, package and remaining release checks are separate.' };
}
