#!/usr/bin/env python3
"""
模拟 OpenAI 兼容端点，专门复现「新模型拒收老参数」这件事。

真实的 gpt-6-luna 我调不到，但它的拒绝方式和 gpt-5 系列是一类：
不收 max_tokens（要 max_completion_tokens）、不收非默认 temperature。
这里按模型名前缀切换几种服务端脾气，用来验证参数协商能不能自己谈拢：

  strict-*  两样都挑剔（新推理模型，如 gpt-6-luna）
  noreason-* 拒 temperature 但也不认识 reasoning_effort
  notemp-*  只挑剔 temperature
  legacy-*  只认 max_tokens，给 max_completion_tokens 反而报错（老模型/第三方中转）
  badkey-*  返回 401，用来看错误信息有没有把原因带出来

GET /_log 取收到的请求序列，GET /_reset 清空。
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = []


def err(msg, code='unsupported_parameter'):
    return {'error': {'message': msg, 'type': 'invalid_request_error', 'code': code}}


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type, authorization')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self._cors()
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/_reset'):
            LOG.clear()
            self._send(200, {'ok': True})
        elif self.path.startswith('/_log'):
            self._send(200, LOG)
        else:
            self._send(404, err('not found'))

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        req = json.loads(self.rfile.read(n) or b'{}')
        model = req.get('model', '')
        LOG.append({
            'model': model,
            'has_max_tokens': 'max_tokens' in req,
            'has_max_completion_tokens': 'max_completion_tokens' in req,
            'temperature': req.get('temperature', None),
            'reasoning_effort': req.get('reasoning_effort', None),
        })

        # noreason-* 认 temperature 的拒绝但不认识 reasoning_effort，
        # 用来验证多摘一个字段也能自愈
        if model.startswith('noreason') and 'reasoning_effort' in req:
            self._send(400, err('Unrecognized request argument supplied: reasoning_effort'))
            return

        if model.startswith('badkey'):
            self._send(401, err('Incorrect API key provided: sk-xxx. '
                                'You can find your API key at https://platform.openai.com/account/api-keys.',
                                'invalid_api_key'))
            return

        if model.startswith(('strict', 'legacy')) or model.startswith('notemp'):
            if model.startswith(('strict', 'notemp')):
                if 'max_tokens' in req and model.startswith('strict'):
                    self._send(400, err(
                        "Unsupported parameter: 'max_tokens' is not supported with this model. "
                        "Use 'max_completion_tokens' instead."))
                    return
                if req.get('temperature') is not None and req['temperature'] != 1:
                    self._send(400, err(
                        "Unsupported value: 'temperature' does not support 0.2 with this model. "
                        "Only the default (1) value is supported.", 'unsupported_value'))
                    return
            if model.startswith('legacy'):
                if 'max_completion_tokens' in req:
                    self._send(400, err(
                        "Unrecognized request argument supplied: max_completion_tokens"))
                    return
                if 'max_tokens' not in req:
                    self._send(400, err('max_tokens is required'))
                    return

        self._send(200, {
            'choices': [{'message': {'role': 'assistant', 'content': '<seg id="1">译文</seg>'}}],
        })


if __name__ == '__main__':
    print('mock OpenAI on http://127.0.0.1:8938')
    ThreadingHTTPServer(('127.0.0.1', 8938), H).serve_forever()
