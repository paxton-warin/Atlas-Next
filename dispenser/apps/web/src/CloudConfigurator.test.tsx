import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CloudConfigurator,
  filterExistingEndpoints,
  selectVisibleActiveEndpoints,
} from "./CloudConfigurator";
describe("CloudFront administration", () => {
  it("has discoverable account, endpoint and review actions without an opaque command prompt", () => {
    const html = renderToStaticMarkup(<CloudConfigurator />);
    expect(html).toContain("AWS accounts");
    expect(html).toContain("Add account");
    expect(html).toContain("No AWS accounts connected.");
  });
  it("supports more than one hundred links and never implies a preview is already deployed", () => {
    const html = renderToStaticMarkup(<CloudConfigurator />);
    expect(html).toContain('max="5000"');
    expect(html).toContain("Destination account");
    expect(html).toContain("New operation");
    expect(html).not.toContain("Deploy now");
  });
  it("does not embed credentials or external scripts into the rendered component", () => {
    const html = renderToStaticMarkup(<CloudConfigurator />);
    expect(html).not.toMatch(
      /<script|AWS_SECRET_ACCESS_KEY|credentials_process|<iframe/,
    );
    expect(html).toContain("Add existing endpoint");
    expect(html).toContain("Origin hostname");
  });
  it("makes endpoint role filters and an accessible search field discoverable", () => {
    const html = renderToStaticMarkup(<CloudConfigurator />);
    expect(html).toContain('aria-label="Endpoint type"');
    expect(html).toContain('aria-label="Search endpoints"');
    expect(html).toContain('aria-pressed="true"');
    for (const label of ["All", "Frontends", "Nodes", "Hub"])
      expect(html).toContain(`>${label}</button>`);
    expect(html).toContain("0 of 0 endpoints");
  });
});
const endpoint = (
  id: string,
  role: "frontend" | "node" | "hub",
  state = "active",
) => ({
  id,
  role,
  state,
  logicalId: "Logical-" + id,
  linkId: role === "frontend" ? "link-" + id : null,
  accountId: "account",
  distributionId: "DIST-" + id,
  url: `https://${id}.cloudfront.net`,
  originHost: "origin.example",
  revision: 4,
});
describe("Existing endpoint filtering and selection", () => {
  const front = endpoint("front", "frontend"),
    node = endpoint("node", "node"),
    hub = endpoint("hub", "hub"),
    names = new Map([["link-front", "Atlas Link One"]]);
  it("searches endpoint name, logical ID and URL case-insensitively with role filters", () => {
    expect(
      filterExistingEndpoints(
        [front, node, hub],
        names,
        "all",
        " aTLAs LiNk oNe ",
      ),
    ).toEqual([front]);
    expect(
      filterExistingEndpoints([front, node, hub], names, "all", "lOGIcal-NoDe"),
    ).toEqual([node]);
    expect(
      filterExistingEndpoints(
        [front, node, hub],
        names,
        "all",
        "HUB.CLOUDFRONT.NET",
      ),
    ).toEqual([hub]);
    expect(
      filterExistingEndpoints([front, node, hub], names, "node", "cloudfront"),
    ).toEqual([node]);
    expect(
      filterExistingEndpoints(
        [front, node, hub],
        names,
        "frontend",
        "Logical-node",
      ),
    ).toEqual([]);
    expect(
      filterExistingEndpoints([front, node, hub], names, "all", "  "),
    ).toEqual([front, node, hub]);
  });
  it("selects only visible active endpoints while retaining hidden selections and create drafts", () => {
    const hidden = {
      kind: "replace" as const,
      endpointId: "hidden",
      revision: 2,
    };
    const create = {
      kind: "create" as const,
      role: "frontend" as const,
      count: 101,
      originHost: "draft.example",
      logicalId: "draft",
    };
    const result = selectVisibleActiveEndpoints(
      [hidden, create],
      [
        front,
        endpoint("staged", "node", "staged"),
        endpoint("retired", "frontend", "transition"),
      ],
    );
    expect(result).toEqual([
      hidden,
      create,
      { kind: "replace", endpointId: "front", revision: 4 },
    ]);
  });
  it("never duplicates an existing selection or silently refreshes its reviewed revision", () => {
    const chosen = {
      kind: "replace" as const,
      endpointId: front.id,
      revision: 1,
    };
    expect(selectVisibleActiveEndpoints([chosen], [front])).toEqual([chosen]);
  });
});
