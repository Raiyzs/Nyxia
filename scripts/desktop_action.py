#!/usr/bin/env python3
"""
AT-SPI desktop automation bridge for Nyxia Phase 4.4.
Called by desktop.js via child_process.spawn.
Args: JSON string on argv[1] — { action, ... }
Returns: JSON on stdout.
"""
import sys
import json
import logging
import os

# Suppress all library noise — only JSON goes to stdout
logging.disable(logging.CRITICAL)
os.environ['DOGTAIL_QUIET'] = '1'

# Redirect stderr to /dev/null so AT-SPI warnings don't interfere
import io
_real_stderr = sys.stderr
sys.stderr = open(os.devnull, 'w')


def list_apps():
    import dogtail.tree as tree
    apps = tree.root.applications()
    return {'apps': [a.name for a in apps if a.name]}


def find_app(name):
    import dogtail.tree as tree
    name_l = name.lower()
    for app in tree.root.applications():
        if name_l in (app.name or '').lower():
            return {'found': True, 'name': app.name}
    return {'found': False, 'name': name}


def click_element(app_name, label):
    import dogtail.tree as tree
    name_l = app_name.lower()
    label_l = label.lower()
    for app in tree.root.applications():
        if name_l in (app.name or '').lower():
            try:
                node = app.findChild(
                    lambda n: label_l in (n.name or '').lower() and n.actions,
                    retry=False
                )
                node.doAction(node.actions[0])
                return {'success': True, 'clicked': label}
            except Exception as e:
                return {'success': False, 'error': str(e)}
    return {'success': False, 'error': f'App not found: {app_name}'}


def type_text(app_name, text):
    import dogtail.tree as tree
    import pyatspi
    name_l = app_name.lower()
    for app in tree.root.applications():
        if name_l in (app.name or '').lower():
            try:
                field = app.findChild(
                    lambda n: n.roleName in ('text', 'entry', 'editable text')
                    and pyatspi.STATE_EDITABLE in n.getState().getStates(),
                    retry=False
                )
                field.text = text
                return {'success': True, 'typed': text}
            except Exception as e:
                return {'success': False, 'error': str(e)}
    return {'success': False, 'error': f'App not found: {app_name}'}


def read_state(app_name):
    import dogtail.tree as tree
    name_l = app_name.lower()
    for app in tree.root.applications():
        if name_l in (app.name or '').lower():
            try:
                texts = []

                def collect(node, depth=0):
                    if depth > 3 or len(texts) >= 15:
                        return
                    t = getattr(node, 'text', None) or getattr(node, 'name', None)
                    if t and t.strip():
                        texts.append(t.strip()[:120])
                    for child in (node.children or [])[:6]:
                        collect(child, depth + 1)

                collect(app)
                return {'found': True, 'name': app.name, 'content': texts}
            except Exception as e:
                return {'found': True, 'name': app.name, 'error': str(e)}
    return {'found': False, 'name': app_name}


def main():
    try:
        args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except Exception as e:
        print(json.dumps({'error': f'Bad args: {e}'}))
        return

    action = args.get('action', 'list_apps')

    try:
        if action == 'list_apps':
            print(json.dumps(list_apps()))
        elif action == 'find_app':
            print(json.dumps(find_app(args.get('name', ''))))
        elif action == 'click_element':
            print(json.dumps(click_element(args.get('app', ''), args.get('label', ''))))
        elif action == 'type_text':
            print(json.dumps(type_text(args.get('app', ''), args.get('text', ''))))
        elif action == 'read_state':
            print(json.dumps(read_state(args.get('app', ''))))
        else:
            print(json.dumps({'error': f'Unknown action: {action}'}))
    except Exception as e:
        print(json.dumps({'error': str(e)}))


if __name__ == '__main__':
    main()
