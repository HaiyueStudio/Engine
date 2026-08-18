# Security policy

## Supported releases

HaiYue has not published its first stable artifact yet. After the first public release, the latest `0.1.x` patch is the supported line; release candidates and older patches receive fixes only when the release owner explicitly marks them supported.

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/HypnosNova/HaiYue/security/advisories/new). Do not open a public issue before the report has been triaged.

Include the affected package/application and version, impact, reproduction steps, relevant platform/browser/device details, and the smallest safe proof of concept. Do not attach production credentials, signing keys, access tokens, personal data, or unrelated proprietary assets.

The maintainers will acknowledge the report, establish severity and affected versions, coordinate a fix and disclosure window, and publish remediation guidance when an accepted release is affected. Acknowledgement or remediation timing is not guaranteed for unsupported snapshots.

## Release credential boundary

Local builds and release rehearsals never require npm publish tokens, GitHub release credentials, signing certificates, notarization credentials, or production deployment secrets. Real publication and signing may run only after explicit authorization in their protected environments. Those credentials must not be written into the repository, logs, SBOM, provenance, test evidence, application archives, or npm tarballs.

