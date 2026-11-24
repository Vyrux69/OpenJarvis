from types import SimpleNamespace
from unittest import mock

import pytest

from openjarvis.core.types import Message, Role
from tests.engine.test_cloud_extended import _make_cloud_engine


@pytest.mark.parametrize('shape', ['parts_none', 'content_none', 'no_candidates', 'tokens_none', 'usage_none', 'normal'])
def test_google_nullable_response(monkeypatch, shape):
    engine = _make_cloud_engine(monkeypatch)
    part = SimpleNamespace(text='Sí, seguimos con el mismo tema.', function_call=None)
    response = SimpleNamespace(
        candidates=[SimpleNamespace(content=SimpleNamespace(parts=[part]))],
        text='Sí, seguimos con el mismo tema.',
        usage_metadata=SimpleNamespace(prompt_token_count=15, candidates_token_count=10),
    )
    if shape == 'parts_none':
        response.candidates[0].content.parts = None
        response.text = None
    elif shape == 'content_none':
        response.candidates[0].content = None
        response.text = None
    elif shape == 'no_candidates':
        response.candidates = None
        response.text = None
    elif shape == 'tokens_none':
        response.usage_metadata.prompt_token_count = None
        response.usage_metadata.candidates_token_count = None
    elif shape == 'usage_none':
        response.usage_metadata = None
    client = mock.MagicMock()
    client.models.generate_content.return_value = response
    engine._google_client = client
    fake_types = mock.MagicMock()
    with mock.patch.dict('sys.modules', {
        'google': mock.MagicMock(),
        'google.genai': mock.MagicMock(),
        'google.genai.types': fake_types,
    }):
        result = engine.generate([
            Message(role=Role.USER, content='Hoy está frío.'),
            Message(role=Role.ASSISTANT, content='Sí, lleva chamarra.'),
            Message(role=Role.USER, content='Va estar frío el día verdad'),
        ], model='gemini-3.5-flash-lite')
    assert result['content']
    if shape in ('parts_none', 'content_none', 'no_candidates'):
        assert 'No recibí una respuesta utilizable' in result['content']
    else:
        assert result['content'] == response.text
    assert isinstance(result['usage']['total_tokens'], int)
    sent = client.models.generate_content.call_args.kwargs['contents']
    assert len(sent) == 3
    assert sent[-1]['parts'][0]['text'] == 'Va estar frío el día verdad'
