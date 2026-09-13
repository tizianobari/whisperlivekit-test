import base64
import importlib.resources as resources
import logging

logger = logging.getLogger(__name__)

# (tag in the HTML, SVG file in web/src, alt text of the inlined image)
_SVG_IMAGES = (
    ('<img src="/web/src/system_mode.svg" alt="" />', 'system_mode.svg', ''),
    ('<img src="/web/src/light_mode.svg" alt="" />', 'light_mode.svg', ''),
    ('<img src="/web/src/dark_mode.svg" alt="" />', 'dark_mode.svg', ''),
    ('<img src="web/src/settings.svg" alt="Settings" />', 'settings.svg', ''),
)


def _read_web_file(*parts):
    with resources.files('whisperlivekit.web').joinpath(*parts).open('r', encoding='utf-8') as f:
        return f.read()


def _svg_data_uri(name):
    svg = _read_web_file('src', name)
    return f"data:image/svg+xml;base64,{base64.b64encode(svg.encode('utf-8')).decode('utf-8')}"


def get_web_interface_html():
    """Loads the HTML for the web interface using importlib.resources."""
    try:
        return _read_web_file('live_transcription.html')
    except Exception as e:
        logger.error(f"Error loading web interface HTML: {e}")
        return "<html><body><h1>Error loading interface</h1></body></html>"


def _inline_page(html_name, css_name, js_name):
    """Returns a page with its CSS, JS, audio worklet/worker and SVG icons embedded."""
    html_content = _read_web_file(html_name)
    css_content = _read_web_file(css_name)
    js_content = _read_web_file(js_name)
    worklet_code = _read_web_file('pcm_worklet.js')
    worker_code = _read_web_file('recorder_worker.js')

    js_content = js_content.replace(
        'await audioContext.audioWorklet.addModule("/web/pcm_worklet.js");',
        'const workletBlob = new Blob([`' + worklet_code + '`], { type: "application/javascript" });\n' +
        'const workletUrl = URL.createObjectURL(workletBlob);\n' +
        'await audioContext.audioWorklet.addModule(workletUrl);'
    )
    js_content = js_content.replace(
        'recorderWorker = new Worker("/web/recorder_worker.js");',
        'const workerBlob = new Blob([`' + worker_code + '`], { type: "application/javascript" });\n' +
        'const workerUrl = URL.createObjectURL(workerBlob);\n' +
        'recorderWorker = new Worker(workerUrl);'
    )

    # Replace external references
    html_content = html_content.replace(
        f'<link rel="stylesheet" href="{css_name}" />',
        f'<style>\n{css_content}\n</style>'
    )
    html_content = html_content.replace(
        f'<script src="{js_name}"></script>',
        f'<script>\n{js_content}\n</script>'
    )

    # Replace SVG references
    for tag, svg_name, alt in _SVG_IMAGES:
        if tag in html_content:
            html_content = html_content.replace(tag, f'<img src="{_svg_data_uri(svg_name)}" alt="{alt}" />')

    return html_content


def get_inline_ui_html():
    """Returns the complete web interface HTML with all assets embedded in a single call."""
    try:
        return _inline_page('live_transcription.html', 'live_transcription.css', 'live_transcription.js')
    except Exception as e:
        logger.error(f"Error creating embedded web interface: {e}")
        return "<html><body><h1>Error loading embedded interface</h1></body></html>"


def get_inline_subtitles_html():
    """Returns the caption-only subtitle page with all assets embedded."""
    try:
        return _inline_page('subtitles.html', 'subtitles.css', 'subtitles.js')
    except Exception as e:
        logger.error(f"Error creating embedded subtitles interface: {e}")
        return "<html><body><h1>Error loading subtitles interface</h1></body></html>"


if __name__ == '__main__':

    import pathlib

    import uvicorn
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse
    from starlette.staticfiles import StaticFiles

    import whisperlivekit.web as webpkg

    app = FastAPI()
    web_dir = pathlib.Path(webpkg.__file__).parent
    app.mount("/web", StaticFiles(directory=str(web_dir)), name="web")

    @app.get("/")
    async def get():
        return HTMLResponse(get_inline_ui_html())

    @app.get("/subtitles")
    async def get_subtitles():
        return HTMLResponse(get_inline_subtitles_html())

    uvicorn.run(app=app)
