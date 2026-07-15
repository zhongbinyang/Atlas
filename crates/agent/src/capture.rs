use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use xcap::Monitor;

pub fn capture_primary_png() -> Result<Vec<u8>, String> {
    let monitors = Monitor::all().map_err(|e| format!("list monitors: {e}"))?;
    let primary = monitors
        .into_iter()
        .find(|m| m.is_primary())
        .or_else(|| Monitor::all().ok().and_then(|mut v| v.drain(..).next()))
        .ok_or_else(|| "no monitor found".to_string())?;

    let img = primary
        .capture_image()
        .map_err(|e| format!("capture failed: {e}"))?;

    let mut buf = Vec::new();
    {
        let encoder = PngEncoder::new(&mut buf);
        encoder
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("png encode: {e}"))?;
    }
    Ok(buf)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn capture_primary_returns_png_magic() {
        let bytes = capture_primary_png().expect("capture");
        assert!(bytes.len() > 8);
        assert_eq!(&bytes[0..8], b"\x89PNG\r\n\x1a\n");
    }
}
