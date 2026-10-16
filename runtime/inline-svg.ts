/** Static inline SVG graphics, not a claim that inline SVG has secure-image
 * processing semantics. Script/foreign content/animation/external references
 * require their own bound loaders and are rejected before document execution.
 * https://www.w3.org/TR/SVG2/conform.html#processing-modes */
const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const graphics = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textpath",
  "title",
  "desc",
  "symbol",
  "use",
  "lineargradient",
  "radialgradient",
  "stop",
  "pattern",
  "clippath",
  "mask",
  "marker",
  "filter",
  "fegaussianblur",
  "feoffset",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fefuncr",
  "fefuncg",
  "fefuncb",
  "fefunca",
  "femerge",
  "femergenode",
  "feflood",
  "fecomposite",
  "femorphology",
  "feturbulence",
  "fedisplacementmap",
  "fedropshadow",
]);
const attributes = new Set(
  (
    "id class role tabindex focusable style xmlns xmlns:xlink xml:space xml:lang " +
    "x y x1 y1 x2 y2 dx dy width height cx cy r rx ry d points pathlength " +
    "viewbox preserveaspectratio transform opacity color fill fill-opacity fill-rule " +
    "stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit " +
    "stroke-dasharray stroke-dashoffset vector-effect paint-order clip-path clip-rule " +
    "mask maskunits maskcontentunits filter filterunits primitiveunits " +
    "gradientunits gradienttransform spreadmethod offset stop-color stop-opacity " +
    "fx fy fr href xlink:href patternunits patterncontentunits patterntransform " +
    "marker-start marker-mid marker-end markerwidth markerheight markerunits refx refy orient " +
    "font-family font-size font-style font-weight text-anchor dominant-baseline " +
    "alignment-baseline letter-spacing word-spacing textlength lengthadjust startoffset " +
    "method spacing rotate visibility display overflow shape-rendering text-rendering " +
    "in in2 result stddeviation mode type values operator k1 k2 k3 k4 slope intercept " +
    "amplitude exponent tablevalues flood-color flood-opacity radius basefrequency " +
    "numoctaves seed stitchtiles scale xchannelselector ychannelselector " +
    "color-interpolation-filters enable-background"
  ).split(/\s+/),
);
const fragment = /^#[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/;
const fail = (code: string) =>
  Object.assign(new Error(code), {
    name: "SecurityError",
    code,
  });
export function qualifyInlineSVG(
  document: Document,
  options: {
    rewritten?: boolean;
    natives?: {
      querySelectorAll?: typeof Document.prototype.querySelectorAll;
      getAttribute?: typeof Element.prototype.getAttribute;
      setAttribute?: typeof Element.prototype.setAttribute;
      attributes?: PropertyDescriptor;
    };
  } = {},
) {
  const query =
    options.natives?.querySelectorAll ?? Document.prototype.querySelectorAll;
  const get = options.natives?.getAttribute ?? Element.prototype.getAttribute;
  const set = options.natives?.setAttribute ?? Element.prototype.setAttribute;
  const getter =
    options.natives?.attributes ??
    Object.getOwnPropertyDescriptor(Element.prototype, "attributes")!;
  let bytes = 0,
    count = 0;
  // A single document query visits each descendant once, including malformed
  // foreign HTML content under SVG. Namespace and tag checks cover every node.
  for (const element of query.call(document, "svg,svg *")) {
    if (
      ++count > 4096 ||
      element.namespaceURI !== SVG ||
      !graphics.has(element.localName.toLowerCase())
    )
      throw fail("original_plan_svg_element_unsupported");
    const attrs = getter.get!.call(element) as NamedNodeMap;
    if (attrs.length > 128) throw fail("original_plan_svg_attribute_limit");
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs.item(i)!,
        name = attr.name.toLowerCase();
      if (options.rewritten && name.startsWith("runtimekit-attr-")) continue;
      if (!attributes.has(name) && !/^(?:aria|data)-[a-z0-9_.:-]+$/.test(name))
        throw fail("original_plan_svg_attribute_unsupported");
      if (attr.namespaceURI && ![XLINK, XML, XMLNS].includes(attr.namespaceURI))
        throw fail("original_plan_svg_namespace_unsupported");
      const value = options.rewritten
        ? (get.call(element, "runtimekit-attr-" + name) ?? attr.value)
        : attr.value;
      if (
        value.length > 65536 ||
        (bytes += name.length + value.length) > 2 * 1024 * 1024
      )
        throw fail("original_plan_svg_attribute_limit");
      if (name === "href" || name === "xlink:href") {
        if (!fragment.test(value))
          throw fail("original_plan_svg_external_reference");
        if (options.rewritten) set.call(element, attr.name, value);
      } else if (name === "style") {
        // Style declarations continue through the ordinary original-style CSP
        // and CSS graph. Its fragment URL branch is not yet qualified here.
        if (/\\|url\s*\(/i.test(value))
          throw fail("original_plan_svg_style_url_unsupported");
      } else if (!/^(?:aria|data)-/.test(name)) {
        // Presentation-attribute URLs are NOT ordinary CSS stylesheet sinks.
        // Admit same-document paint/clip/filter fragments only; no escaped URL
        // spelling can create an unbrokered external request.
        if (/\\/.test(value))
          throw fail("original_plan_svg_external_reference");
        const remainder = value.replace(
          /url\(\s*(["']?)(#[A-Za-z_][A-Za-z0-9_.:-]{0,255})\1\s*\)/gi,
          "",
        );
        if (
          /url\s*\(/i.test(remainder) ||
          (/(?:javascript|data|https?):/i.test(value) &&
            !["xmlns", "xmlns:xlink"].includes(name))
        )
          throw fail("original_plan_svg_external_reference");
        if (options.rewritten && /url\s*\(/i.test(value))
          set.call(element, attr.name, value);
      }
      if (
        (name === "xmlns" && value !== SVG) ||
        (name === "xmlns:xlink" && value !== XLINK)
      )
        throw fail("original_plan_svg_namespace_unsupported");
    }
  }
  return count;
}
