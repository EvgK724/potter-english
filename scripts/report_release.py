"""Package actual verification evidence; never include private book passages."""
import hashlib,json
from pathlib import Path
from PIL import Image
root=Path(__file__).resolve().parent.parent
coverage=json.loads((root/'coverage.json').read_text())
report=json.loads((root/'evidence/browser-report.json').read_text())
assert {x['browser'] for x in report}=={'chromium','webkit'}
assert all(x['cards']==coverage['uniqueExpressionSenses'] and not x['pageErrors'] and x['offlineReload'] and x['offlineNewPage'] and x['unplayedExampleOffline'] for x in report)
for browser in ['chromium','webkit']:
 image=Image.open(root/'evidence'/f'{browser}-390.png');image.crop((0,0,390,min(1100,image.height))).save(root/'docs'/f'preview-{browser}-mobile.png')
image=Image.open(root/'evidence/chromium-1280.png');image.crop((0,0,1280,min(1000,image.height))).save(root/'docs/preview-desktop.png')
(root/'docs/browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
assets=['index.html','styles.css','app.js','engine.js','data.js','offline.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/icon-maskable.png','icons/apple-touch-icon.png','audio/manifest.json']
shell=sum((root/p).stat().st_size for p in assets)+(root/'index.html').stat().st_size
coverage['offlinePayloadBytes']=shell+coverage['audio']['bytes']
coverage['offlineSizeNote']='Uncompressed cached response bodies, including navigation/index entries; browser storage overhead excluded.'
(root/'coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,indent=2)+'\n')
table='\n'.join(f"| {c['number']} | {c['title']} | {c['wordCount']} | {c['expressionSenses']} |" for c in coverage['chapters'])
text=f'''# Проверка выпуска Potter English

Приложение: https://evgk724.github.io/potter-english/  
Репозиторий: https://github.com/EvgK724/potter-english  
QR: https://evgk724.github.io/potter-english/icons/install-qr.png

## Содержание

**{coverage['uniqueExpressionSenses']} карточки**: {coverage['types']['phrasal']} фразовых/предложных глаголов, {coverage['types']['idiom']} идиома и устойчивый оборот, {coverage['types']['collocation']} коллокация. Считаются отдельные выражения и значения; одно выражение может иметь несколько смыслов и несколько глав.

Исходник — загруженный пользователем английский EPUB **Harry Potter and the Sorcerer's Stone**, американская формулировка. Издатель и ISBN не подтверждены. DRM-обход не применялся. Проанализированы все 17 глав, {coverage['sourceWords']:,} английское слово по указанному в coverage.json правилу подсчёта.

Метод: полный смысловой проход по главам → короткие точные подтверждения в исходнике → разделение значений → объединение подтверждённых дублей между главами → оригинальные B2-примеры и русские пояснения → независимые семантические проверки. Проверено {coverage['verifiedEvidenceCount']} коротких подтверждения. После дополнительной выборки из 30 карточек (включая 27 по матрице 3 категории × 3 карточки × главы 1, 9, 17) исключены 2 свободные конструкции и уточнена 1 категория. Применены 19 уточнений русских значений/переводов/пояснений и одного учебного примера.

Глагольная категория включает также предложные глаголы, например approve of; «Идиомы и обороты» включает устойчивые речевые формулы. Не всякое сочетание соседних слов включалось в набор. Полный проход по всем главам **не доказывает отсутствие пропусков**: коллокации — открытый класс. Главы обозначают проверенные появления, а не исчерпывающую конкорданцию.

| Глава | Название | Слова | Карточки/значения |
| --- | --- | ---: | ---: |
{table}

## Ryan и офлайн

Голос: Microsoft **en-GB-RyanNeural**, синтетический британский мужской. У всех {coverage['uniqueExpressionSenses']} карточек озвучены выражение и пример; всего **{coverage['audio']['files']} уникальных MP3**. Совпадающие тексты выражений используют общий файл. Проверены точный учебный текст, идентификатор голоса, SHA-256, размер, длительность и декодирование ненулевой PCM-громкости каждого файла.

Аудио: **{coverage['audio']['bytes']:,} байт ({coverage['audio']['bytes']/1024/1024:.2f} МиБ)**. Полный офлайн-пакет: **{coverage['offlinePayloadBytes']:,} байт ({coverage['offlinePayloadBytes']/1024/1024:.2f} МиБ)** без служебных накладных расходов браузера.

Записи доступны как статические MP3; аккаунт Azure, системный Ryan или онлайн-TTS во время занятия не нужны. На iOS первый запуск и сохранение требуют сети; iOS может очищать данные сайта. Проверяются реальные файлы и хеши, недостающее восстанавливается при повторной загрузке. Нет обещания вечного хранения.

## Выполненные проверки

- 24 Node-теста: данные, главы/поиск, повторение, безопасный импорт, лимиты, разные значения, сохранение признака кандидата, целостность аудио, отмена/возобновление, Safari Range, восстановление удалённой оболочки, потеря файла во время загрузки; сохранность кэшей других приложений.
- 6 Python-тестов генератора: разделённые партии, строгая полнота, безопасное удаление лишних записей из каталога, отсутствие/пустой набор, общие файлы и конфликт текста.
- Chromium и WebKit: ширины 320/360/375/390/430/820/1280 px; учебный текст 22 px без горизонтального переполнения.
- Поиск, пустая выдача, типы, главы, избранное, скрытый ответ, сохранение повторов; реальное движение currentTime при озвучке выражения и примера.
- Скачивание главы и всего набора, затем физическое отключение HTTP-ответов: повторная загрузка страницы, новая вкладка, поиск и ранее не воспроизводившийся пример работают офлайн в обоих браузерах.
- Отсутствующее MP3 выдаёт понятную ошибку; подмена голоса отсутствует. Проверены ошибочный JSON, безопасный вывод HTML-подобного текста, подтверждение TXT-кандидатов и честное сообщение при отказе localStorage.

WebKit — браузерная проверка; установка и запуск на физическом iPhone/iPad в этой среде не проверялись. Данные пользователя хранятся локально, синхронизации между устройствами нет. EPUB, полный извлечённый текст и подтверждающие фрагменты исключены из Git и публичной сборки.

[Браузерный отчёт](browser-report.json) · [Метаданные покрытия](../coverage.json)
'''
(root/'docs/verification.md').write_text(text)
print('Created public verification report and 3 previews; offline bytes',coverage['offlinePayloadBytes'])
