#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""欧路开放平台「生词本 API」本地替身（只用于离线回归测试，不联网）。

按官方文档实现契约（https://my.eudic.net/doc/api_study.md / index.md）：
  * 未带正确 Authorization: NIS xxx      -> 401
  * POST /studylist/words 缺 category_id -> 400（官方：id 已废弃，必填 category_id）
  * 正常加词                             -> 201 {"message": "单词导入成功,导入数量 : N"}
  * GET  /studylist/category             -> 200 {"data": [...]}
测试开关：
  GET /__mode?set=ok|400|401|403   设置后续 API 响应的模式
  GET /__requests                  返回已记录的请求（来自 eudic_stub_requests.jsonl）
  GET /__book?cat=0                返回替身里某个生词本已收到的词
"""
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
REQLOG = os.path.join(HERE, 'eudic_stub_requests.jsonl')
LOCK = threading.Lock()
STATE = {'mode': 'ok'}
BOOKS = {'0': [], '190000000000000001': []}
CATS = [{'id': '0', 'language': 'es', 'name': '默认生词本'},
        {'id': '190000000000000001', 'language': 'es', 'name': '西语精读'}]


def record(entry):
    with LOCK, open(REQLOG, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def readlog():
    with LOCK:
        if not os.path.exists(REQLOG):
            return []
        return [json.loads(x) for x in open(REQLOG, encoding='utf-8') if x.strip()]


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'authorization,content-type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _authed(self):
        a = self.headers.get('Authorization', '')
        return a.startswith('NIS ') and len(a.strip()) > 6

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == '/__mode':
            if 'set' in q:
                STATE['mode'] = q['set'][0]
            return self._send(200, {'mode': STATE['mode']})
        if u.path == '/__requests':
            return self._send(200, readlog())
        if u.path == '/__book':
            cat = (q.get('cat') or ['0'])[0]
            return self._send(200, {'cat': cat, 'words': BOOKS.get(cat, [])})
        if u.path.endswith('/studylist/category'):
            if not self._authed():
                return self._send(401, {'message': '授权认证未通过'})
            if STATE['mode'] == '403':
                return self._send(403, {'message': '访问过于频繁，禁止访问'})
            return self._send(200, {'data': CATS, 'message': ''})
        return self._send(404, {'message': 'not found'})

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n).decode('utf-8') if n else ''
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {'_bad_json': raw[:200]}
        record({'path': u.path, 'auth': (self.headers.get('Authorization') or '')[:8],
                'ctype': self.headers.get('Content-Type'), 'body': body, 'mode': STATE['mode']})

        if not u.path.startswith('/api/open/'):
            return self._send(404, {'message': 'not found'})
        if not self._authed():
            return self._send(401, {'message': '授权认证未通过'})
        if STATE['mode'] == '401':
            return self._send(401, {'message': '授权认证未通过，或授权已过期'})
        if STATE['mode'] == '403':
            return self._send(403, {'message': '访问过于频繁，禁止访问'})

        if u.path.endswith('/studylist/words'):
            # 官方文档：id 已废弃，必填 category_id
            if 'category_id' not in body:
                return self._send(400, {'message': '参数存在错误：缺少 category_id（id 已废弃）'})
            if 'id' in body:
                # 2026-10-01 用真 token 实测线上服务端：带上已废弃的 id 直接 400「参数不正确：id」
                return self._send(400, {'message': '参数不正确：id'})
            if str(body['category_id']) not in BOOKS:
                return self._send(400, {'message': '参数不正确：category_id 不存在'})
            if body.get('language') not in ('en', 'fr', 'de', 'es'):
                return self._send(400, {'message': '参数存在错误：language 不合法'})
            words = body.get('words')
            if not isinstance(words, list) or not words:
                return self._send(400, {'message': '参数存在错误：words 必须是非空数组'})
            cat = str(body['category_id'])
            BOOKS.setdefault(cat, [])
            added = 0
            for w in words:
                w = str(w).strip().lower()
                if w and w not in BOOKS[cat]:
                    BOOKS[cat].append(w)
                    added += 1
            return self._send(201, {'message': '单词导入成功,导入数量 : %d' % added})

        if u.path.endswith('/studylist/category'):
            name = str(body.get('name') or '').strip()
            if not name:
                return self._send(400, {'message': '参数存在错误：name 必填'})
            cat = {'id': '190000000000000001', 'language': body.get('language', 'es'), 'name': name}
            CATS.append(cat)
            BOOKS.setdefault(cat['id'], [])
            return self._send(201, {'data': cat, 'message': '创建成功'})

        return self._send(404, {'message': 'not found'})


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8734
    open(REQLOG, 'w', encoding='utf-8').close()
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
