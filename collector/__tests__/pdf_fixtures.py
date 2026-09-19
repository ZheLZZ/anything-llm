"""Generate synthetic PDF regression inputs without retaining user documents."""

from pathlib import Path
import sys
import pymupdf

root = Path(sys.argv[1])
with pymupdf.open() as doc:
    page = doc.new_page()
    page.insert_text((50, 60), "证券及期货事务监察委员会 海螺 用户 视频", fontname="china-s")
    page.insert_text((50, 90), "English revenue 2024: 30,523")
    assert all(doc.xref_get_key(font[0], "ToUnicode")[0] == "null" for font in page.get_fonts())
    doc.new_page()  # Page numbers must not collapse when empty pages are skipped.
    doc.new_page().insert_text((50, 60), "證券及期貨事務監察委員會", fontname="china-t")
    doc.set_metadata({"creator": "Synthetic PDF test", "title": "CJK regression"})
    doc.save(root / "中文 test.pdf")
    doc.save(root / "locked.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256,
             owner_pw="owner-password", user_pw="reader-password")
with pymupdf.open() as doc:
    page = doc.new_page()
    pix = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 20, 20), False)
    pix.clear_with(255)
    page.insert_image(pymupdf.Rect(50, 50, 100, 100), pixmap=pix)
    doc.save(root / "image-only.pdf")
(root / "invalid.pdf").write_text("This is not a PDF.", encoding="utf-8")
