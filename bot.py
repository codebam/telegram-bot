#!/usr/bin/env python

import telegram
import sys
import os
from flask import Flask, request
sys.path.append(os.path.join(os.path.abspath('.'), 'venv/lib/python2.7/site-packages'))

app = Flask(__name__)

file_ = open('token')
token_=file_.read().rstrip('\n')

global bot
bot = telegram.Bot(token=token_)


@app.route('/'+token_, methods=['POST'])
def webhook_handler():
    if request.method == "POST":
        # retrieve the message in JSON and then transform it to Telegram object
        update = telegram.Update.de_json(request.get_json(force=True))

        chat_id = update.message.chat.id

        # Telegram understands UTF-8, so encode text for unicode compatibility
        text = update.message.text.encode('utf-8')

        # repeat the same message back (echo)
        bot.sendMessage(chat_id=chat_id, text=text)

    return 'ok'


@app.route('/set_webhook', methods=['GET', 'POST'])
def set_webhook():
    s = bot.setWebhook('https://telegram-bot-1370/'+token_)
    if s:
        return "webhook setup ok"
    else:
        return "webhook setup failed"


@app.route('/')
def index():
    return '.'
