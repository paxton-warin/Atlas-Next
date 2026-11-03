# Documentation

## Development and components

- [Repository layout, root commands and dependency policy](REPOSITORY.md)
- [Test commands, fixture provenance and known DB-suite failures](TESTING.md)
- [Local files: what to retain and what is disposable](LOCAL-FILES.md)
- [Hub setup](../dispenser/README.md), [Hub architecture](../dispenser/docs/architecture.md)
- [Combined local laboratory](HUB_LOCAL_LAB.md) — opt-in, disposable development only
- [AI configuration](AI.md), [request controls](REQUEST-LIMITS.md)
- [Tool categories and old-to-new path map](../tools/README.md)

## Deployment procedures

These documents describe explicit operations and sometimes older topologies.
They are not current fleet inventories or instructions to run during a source
cleanup. Review actual server-owned configuration and the component's release
acceptance before using any deployment/migration procedure.

- [Main/node setup](NODES.md), [three-VPS setup](THREE-VPS-SETUP.md)
- [Routine browsing-controls update](UPDATE-BROWSING-CONTROLS.md)
- [Historical frontend-relay migration](UPDATE-FRONTEND-RELAY.md)
- [CloudFront replacement procedure](CLOUDFRONT-RESET.md) — older browser/node scope;
  not the complete Hub-account migration procedure
- [Shared-host Caddy recovery](VPS2-DISPENSER-RECOVERY.md)
- [Hub cloud configuration](../dispenser/docs/HUB_CLOUD_CONFIGURATOR.md)

## Historical investigations

`archive/` separates dated release/investigation claims from maintained setup.
Existing links to deleted `evidence/` reports in archived documents are historical
citations, not current build/test dependencies or proof of current deployment.

- [Client compatibility, October 13](archive/CLIENT-COMPATIBILITY-20261013.md)
- [Retired filter-rewriting investigation](archive/FILTER-REWRITING-20261013.md)
- [Combined frontend-frame candidate, October 16](archive/COMBINED-UPDATE-20261016.md)
- [Hub local candidate, October 20](archive/HUB_COMBINED_CANDIDATE.md)
- [Compatibility register](COMPATIBILITY.md) — dated individual fixture observations

Permanent startup-source history is in [maintenance/history](../maintenance/history/README.md).
