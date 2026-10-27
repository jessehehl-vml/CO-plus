// Minimal PowerPoint (OOXML) writer: one embedded MP4 per 16:9 slide.
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = NS_R;
const CT = "application/vnd.openxmlformats-officedocument.presentationml";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const EMU_PER_PX = 9525;

const escapeXml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (char) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char],
  );

const relationships = (items) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;

const emptyTree =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const color = (name, value) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
const THEME = `${XML}<a:theme xmlns:a="${NS_A}" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>${color("dk2", "44546A")}${color("lt2", "E7E6E6")}${color("accent1", "4472C4")}${color("accent2", "ED7D31")}${color("accent3", "A5A5A5")}${color("accent4", "FFC000")}${color("accent5", "5B9BD5")}${color("accent6", "70AD47")}${color("hlink", "0563C1")}${color("folHlink", "954F72")}</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050]
  .map((width) => `<a:ln w="${width}">${solid}</a:ln>`)
  .join("")}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const MASTER = `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

const LAYOUT = `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

// Layout follows the team's storyboard template: format label top-left, hint bottom-left.
const MAX_UPSCALE = 2;
const TITLE_RIGHT = 3500000;
const TITLE_BOTTOM = 850000;
const AREA = { left: 400000, right: 11792000, top: 125000, bottom: 6050000 };

function videoFrame(width, height) {
  const w = width * EMU_PER_PX;
  const h = height * EMU_PER_PX;
  const fit = (boxWidth, boxHeight) =>
    Math.min(MAX_UPSCALE, boxWidth / w, boxHeight / h);
  // Either use the full width below the title, or the full height beside it.
  const below = fit(AREA.right - AREA.left, AREA.bottom - TITLE_BOTTOM);
  const beside = fit(AREA.right - TITLE_RIGHT, AREA.bottom - AREA.top);
  const scale = Math.max(below, beside);
  const cx = Math.round(w * scale);
  const cy = Math.round(h * scale);
  const [left, top] =
    below >= beside ? [AREA.left, TITLE_BOTTOM] : [TITLE_RIGHT, AREA.top];
  const x = Math.min(
    AREA.right - cx,
    Math.max(left, Math.round((SLIDE_WIDTH - cx) / 2)),
  );
  const y = Math.round(top + (AREA.bottom - top - cy) / 2);
  return { x, y, cx, cy };
}

function textBox(id, name, [x, y, cx, cy], body, outline = "") {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>${outline}</p:spPr><p:txBody>${body}</p:txBody></p:sp>`;
}

function formatLabel(width, height) {
  const run = (text) =>
    `<a:r><a:rPr lang="en-US" sz="1800" b="1" dirty="0"><a:solidFill><a:srgbClr val="00AFEF"/></a:solidFill><a:latin typeface="Calibri"/><a:cs typeface="Calibri"/></a:rPr><a:t>${text}</a:t></a:r>`;
  const paragraph = (text) =>
    `<a:p><a:pPr marL="90170"><a:spcBef><a:spcPts val="240"/></a:spcBef></a:pPr>${run(text)}</a:p>`;
  return textBox(
    3,
    "Banner format",
    [32657, 115322, 3274060, 610424],
    `<a:bodyPr wrap="square" lIns="0" tIns="30480" rIns="0" bIns="0" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraph("Banner format:")}${paragraph(`${width}x${height}`)}`,
    '<a:ln w="9525"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>',
  );
}

const HOVER_HINT = textBox(
  4,
  "Hover hint",
  [304800, 6096000, 5257800, 369332],
  '<a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1800" dirty="0"/><a:t>*Hover over image for animation control bar</a:t></a:r></a:p>',
);

function slideXml(slide, index) {
  const { x, y, cx, cy } = videoFrame(slide.width, slide.height);
  const name = escapeXml(slide.name);
  return `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${emptyTree}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Video ${index}" descr="${name}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rId2"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId3"/></p:ext></p:extLst></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>${formatLabel(slide.width, slide.height)}${HOVER_HINT}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:video><p:cMediaNode vol="80000"><p:cTn id="2" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cMediaNode></p:video></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>`;
}

export async function buildPresentation(slides, JSZip) {
  if (!slides.length) throw new Error("There are no recordings to place in PowerPoint.");
  const zip = new JSZip();
  const count = slides.length;
  const numbers = slides.map((_, index) => index + 1);
  zip.file(
    "[Content_Types].xml",
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="mp4" ContentType="video/mp4"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/>${numbers
      .map(
        (n) =>
          `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT}.slide+xml"/>`,
      )
      .join("")}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="${CT}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${CT}.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    relationships([
      ["rId1", `${REL}/officeDocument`, "ppt/presentation.xml"],
      [
        "rId2",
        "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
        "docProps/core.xml",
      ],
      ["rId3", `${REL}/extended-properties`, "docProps/app.xml"],
    ]),
  );
  zip.file(
    "docProps/core.xml",
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Ad recordings</dc:title><dc:creator>CO Plus</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>CO Plus</Application><Slides>${count}</Slides></Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${numbers
      .map((n) => `<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`)
      .join("")}</p:sldIdLst><p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    relationships([
      ["rId1", `${REL}/slideMaster`, "slideMasters/slideMaster1.xml"],
      ...numbers.map((n) => [`rId${n + 1}`, `${REL}/slide`, `slides/slide${n}.xml`]),
      [`rId${count + 2}`, `${REL}/theme`, "theme/theme1.xml"],
      [`rId${count + 3}`, `${REL}/presProps`, "presProps.xml"],
      [`rId${count + 4}`, `${REL}/viewProps`, "viewProps.xml"],
      [`rId${count + 5}`, `${REL}/tableStyles`, "tableStyles.xml"],
    ]),
  );
  zip.file(
    "ppt/presProps.xml",
    `${XML}<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`,
  );
  zip.file(
    "ppt/viewProps.xml",
    `${XML}<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`,
  );
  zip.file(
    "ppt/tableStyles.xml",
    `${XML}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
  );
  zip.file("ppt/theme/theme1.xml", THEME);
  zip.file("ppt/slideMasters/slideMaster1.xml", MASTER);
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    relationships([
      ["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"],
      ["rId2", `${REL}/theme`, "../theme/theme1.xml"],
    ]),
  );
  zip.file("ppt/slideLayouts/slideLayout1.xml", LAYOUT);
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    relationships([["rId1", `${REL}/slideMaster`, "../slideMasters/slideMaster1.xml"]]),
  );
  for (const [index, slide] of slides.entries()) {
    const n = index + 1;
    zip.file(`ppt/media/media${n}.mp4`, await slide.video.arrayBuffer());
    zip.file(`ppt/media/image${n}.png`, await slide.poster.arrayBuffer());
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(slide, n));
    zip.file(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      relationships([
        ["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"],
        ["rId2", `${REL}/video`, `../media/media${n}.mp4`],
        ["rId3", "http://schemas.microsoft.com/office/2007/relationships/media", `../media/media${n}.mp4`],
        ["rId4", `${REL}/image`, `../media/image${n}.png`],
      ]),
    );
  }
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    compression: "STORE",
  });
}
