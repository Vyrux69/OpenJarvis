from unittest.mock import MagicMock
import pytest
from openjarvis.agents._stubs import AgentContext
from openjarvis.agents.native_react import NativeReActAgent, _weather_now_request
from openjarvis.core.types import Message, Role


@pytest.mark.parametrize('text', ['Clima en Saltillo Jarvis', 'Va estar frío el día verdad', '¿Lloverá hoy?', 'Temperatura actual', 'Pronóstico para mañana', 'weather today'])
def test_live_weather_guard(text):
    assert _weather_now_request(text, None)


@pytest.mark.parametrize('text', ['Hola Jarvis', '¿Qué es el clima?', '¿Por qué se forma la lluvia?', 'Mi chamarra es azul', 'Busca noticias de Saltillo hoy'])
def test_other_topics_continue(text):
    assert not _weather_now_request(text, None)


def test_weather_followup(monkeypatch):
    monkeypatch.setenv('OPENJARVIS_WEB_SEARCH_DISABLE_FETCH', '1')
    ctx = AgentContext()
    ctx.conversation.add(Message(role=Role.USER, content='Clima en Saltillo'))
    ctx.conversation.add(Message(role=Role.ASSISTANT, content='Ayer bajó a 11 grados.'))
    engine = MagicMock()
    agent = NativeReActAgent(engine, 'test-model')
    result = agent.run('Entonces llevo chamarra verdad', context=ctx)
    assert result.metadata['weather_freshness_unverified']
    assert 'No puedo verificar el clima actual' in result.content
    engine.generate.assert_not_called()


def test_weather_guard_uses_own_deployment_flag(monkeypatch):
    monkeypatch.delenv('OPENJARVIS_WEB_SEARCH_DISABLE_FETCH', raising=False)
    engine = MagicMock()
    engine.generate.return_value = {'content': 'Final Answer: Respuesta normal', 'usage': {}}
    agent = NativeReActAgent(engine, 'test-model')
    assert agent.run('Clima en Saltillo').content == 'Respuesta normal'
    engine.generate.assert_called_once()


def test_links_only_never_echoes_weather_figures(monkeypatch):
    from openjarvis.core.types import ToolResult
    from openjarvis.tools._stubs import BaseTool, ToolSpec

    class SearchStub(BaseTool):
        tool_id = 'web_search'
        @property
        def spec(self):
            return ToolSpec(name='web_search', description='search', parameters={})
        def execute(self, **params):
            return ToolResult(
                tool_name='web_search', success=True,
                content='Source: https://example.com/weather\nSummary: Ayer 11 grados y lluvia.',
            )

    monkeypatch.setenv('OPENJARVIS_WEB_SEARCH_DISABLE_FETCH', '1')
    engine = MagicMock()
    agent = NativeReActAgent(engine, 'test-model', tools=[SearchStub()])
    result = agent.run('Clima actual en Saltillo')
    assert 'https://example.com/weather' in result.content
    assert '11' not in result.content
    assert 'ayer' not in result.content.lower()
    assert 'sin confirmar su actualización' in result.content
    assert result.tool_results[0].success
    engine.generate.assert_not_called()
