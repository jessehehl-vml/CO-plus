const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const JSZip = require("../jszip.min.js");

test("PowerPoint export places each recording on its own slide with resolvable parts", async () => {
  const { buildPresentation } = await import("../recording/pptx.mjs");
  const blob = await buildPresentation(
    [
      { name: "Summer <A>_300x250.mp4", video: new Blob(["v1"]), poster: new Blob(["p1"]), width: 300, height: 250 },
      { name: "Tall_160x600.mp4", video: new Blob(["v2"]), poster: new Blob(["p2"]), width: 160, height: 600 },
    ],
    JSZip,
  );
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const presentation = await zip.file("ppt/presentation.xml").async("string");
  assert.equal((presentation.match(/<p:sldId /g) || []).length, 2);
  for (const n of [1, 2]) {
    const slide = await zip.file(`ppt/slides/slide${n}.xml`).async("string");
    assert.match(slide, /<a:videoFile r:link="rId2"\/>/);
    // PowerPoint treats the video as linked unless this exact ext URI wraps p14:media.
    assert.match(slide, /<p:ext uri="\{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230\}"><p14:media [^>]*r:embed="rId3"\/>/);
    assert.match(slide, /<p:video><p:cMediaNode[^>]*>.*<p:spTgt spid="2"\/>/);
    assert.equal(await zip.file(`ppt/media/media${n}.mp4`).async("string"), `v${n}`);
  }
  assert.match(await zip.file("ppt/slides/slide1.xml").async("string"), /descr="Summer &lt;A&gt;_300x250.mp4"/);
  const small = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.match(small, /<a:t>Banner format:<\/a:t>.*<a:t>300x250<\/a:t>/);
  assert.match(small, /<a:t>\*Hover over image for animation control bar<\/a:t>/);
  const [, cx] = small.match(/<a:ext cx="(\d+)" cy="\d+"\/><\/a:xfrm><a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom><\/p:spPr><\/p:pic>/);
  assert.equal(Number(cx), 300 * 9525 * 2, "small ads are shown at 2x");
  const tall = await zip.file("ppt/slides/slide2.xml").async("string");
  const [, y, cy] = tall
    .match(/<a:off x="\d+" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/><\/a:xfrm><a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom><\/p:spPr><\/p:pic>/)
    .map(Number);
  assert(y + cy <= 6096000, "tall ads stay above the hover hint");
  const types = await zip.file("[Content_Types].xml").async("string");
  for (const name of Object.keys(zip.files).filter((file) => file.endsWith(".rels"))) {
    const base = path.posix.dirname(path.posix.dirname(name));
    const rels = await zip.file(name).async("string");
    for (const [, target] of rels.matchAll(/Target="([^"]+)"/g)) {
      const resolved = path.posix.normalize(path.posix.join(base, target));
      assert(zip.file(resolved), `${name} -> ${resolved}`);
      if (resolved.endsWith(".xml"))
        assert(types.includes(`PartName="/${resolved}"`), `content type for ${resolved}`);
    }
  }
});
