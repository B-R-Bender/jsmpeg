JSMpeg.BitBuffer2 = (function () {
    "use strict";

    /**
     * Буффер для возможности читать побитово хранит целые байты
     * @param bufferOrLength буфер или длина
     * @param mode режим расширения (замена или расширение)
     * @constructor
     */
    function BitBuffer(bufferOrLength, mode) {
        if (typeof (bufferOrLength) === "object") {
            //сам буфер
            this.bytes = (bufferOrLength instanceof Uint8Array) ? bufferOrLength : new Uint8Array(bufferOrLength);
            //фактический размер данных в буфере в целых байтах
            this.byteLength = this.bytes.length;
        } else {
            this.bytes = new Uint8Array(bufferOrLength || 1024 * 1024);
            this.byteLength = 0;
        }
        //режим
        this.mode = mode || BitBuffer.MODE.EXPAND;
        //текущий указатель прочитанный БИТ
        this.index = 0;
    }

    /**
     * Изменить размер внтуреннего буфера
     * @param size новый размер
     */
    BitBuffer.prototype.resize = function (size) {
        //новый буфер
        const newBytes = new Uint8Array(size);
        const hasData = this.byteLength !== 0;
        if (hasData) {
            //если уменьшили то будет фактически size
            this.byteLength = Math.min(this.byteLength, size);
            //заполнили тем, что есть новый буфер
            newBytes.set(this.bytes, 0, this.byteLength);
        }
        //обновили буфер
        this.bytes = newBytes;
        //обновили индекс - или старый если не уменьшали или новый если размер буфера меньше
        this.index = Math.min(this.index, this.byteLength << 3);
    };

    /**
     * Освободить место в буфере (что-то типа копирующего GC) если есть данные которые прочитали - выбросим их из буфера
     * и сместим оставщиеся в начало
     * @param sizeNeeded необходимый размер, который хотелось бы очистить
     */
    BitBuffer.prototype.evict = function (sizeNeeded) {
        const bytePos = this.index >> 3,
            available = this.bytes.length - this.byteLength;

        // If the current index is the write position, we can simply reset both
        // to 0. Also reset (and throw away yet unread data) if we won't be able
        // to fit the new data in even after a normal eviction.
        if (this.index === this.byteLength << 3 || sizeNeeded > available + bytePos /*emergency evac*/) {
            this.byteLength = 0;
            this.index = 0;
            return;
        } else if (bytePos === 0) {
            // Nothing read yet - we can't evict anything
            return;
        }

        // Some browsers don't support copyWithin() yet - we may have to do
        // it manually using set and a subarray
        if (this.bytes.copyWithin) {
            this.bytes.copyWithin(0, bytePos, this.byteLength);
        } else {
            this.bytes.set(this.bytes.subarray(bytePos, this.byteLength));
        }

        this.byteLength = this.byteLength - bytePos;
        this.index -= bytePos << 3;
    };

    /**
     * Запись в буфер
     * @param bufferOrBuffersArray один буфер или массив буферов для записи
     * @returns {number} количество записанных данных в байтах
     */
    BitBuffer.prototype.write = function (bufferOrBuffersArray) {
        let buffersArray = (typeof (bufferOrBuffersArray[0]) === 'object'),
            totalLength = 0,
            available = this.bytes.length - this.byteLength;

        // Calculate total byte length
        if (buffersArray) {
            for (let index = 0; index < bufferOrBuffersArray.length; index++) {
                totalLength += bufferOrBuffersArray[index].byteLength;
            }
        } else {
            totalLength = bufferOrBuffersArray.byteLength;
        }

        // Do we need to resize or evict?
        if (totalLength > available) {
            if (this.mode === BitBuffer.MODE.EXPAND) {
                const newSize = Math.max(this.bytes.length * 2, totalLength - available);
                this.resize(newSize)
            } else {
                this.evict(totalLength);
            }
        }

        if (buffersArray) {
            for (let index = 0; index < bufferOrBuffersArray.length; index++) {
                this.appendSingleBuffer(bufferOrBuffersArray[index]);
            }
        } else {
            this.appendSingleBuffer(bufferOrBuffersArray);
        }

        return totalLength;
    };

    /**
     * Добавить к буферу данные еще одного
     * @param buffer переданные данные
     */
    BitBuffer.prototype.appendSingleBuffer = function (buffer) {
        buffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

        this.bytes.set(buffer, this.byteLength);
        this.byteLength += buffer.length;
    };

    /**
     * Найти следующий start code заголовка PES и установить указатель на его начало
     * @returns {*|number|number} или Stream ID (4-й байт) если нашел или -1
     */
    BitBuffer.prototype.findNextStartCode = function () {
        for (let currentByteIndex = (this.index + 7 >> 3); currentByteIndex < this.byteLength; currentByteIndex++) {
            if (this.isBytesAreStartCode(currentByteIndex)) {
                this.index = (currentByteIndex + 4) << 3;
                return this.bytes[currentByteIndex + 3];
            }
        }
        this.index = (this.byteLength << 3);
        return -1;
    };

    /**
     * Найти начало данных конкретного streamId и установить указатель на начало
     * @param streamId судя по всему это будет stream ID из заголовка PES его то и будем сравнивать
     * @returns {number|*} или stream ID или -1 если не найдено
     */
    BitBuffer.prototype.findStartCode = function (streamId) {
        let current = 0;
        while (true) {
            current = this.findNextStartCode();
            if (current === streamId || current === -1) {
                return current;
            }
        }
    };

    /**
     * Проверить, является ли следующий байт началом нового PES
     * @returns {boolean} да/нет
     */
    BitBuffer.prototype.nextBytesAreStartCode = function () {
        const byteIndex = (this.index + 7 >> 3);
        return (byteIndex >= this.byteLength || this.isBytesAreStartCode(byteIndex));
    };

    /**
     * Является ли последовательность байт, начиная с переданного индекса, start code'ом из заголовка PES
     * @param byteIndex интересующий индекс
     * @returns {boolean} да/нет
     */
    BitBuffer.prototype.isBytesAreStartCode = function (byteIndex) {
        return (this.bytes[byteIndex] === 0x00 && this.bytes[byteIndex + 1] === 0x00 && this.bytes[byteIndex + 2] === 0x01);
    };

    /**
     * Получить следующие {count} бит с текущего индекса
     * @param count количество бит
     * @returns {number} результат
     */
    BitBuffer.prototype.peek = function (count) {
        let offset = this.index;
        let value = 0;
        while (count) {
            const currentByte = this.bytes[offset >> 3],
                remaining = 8 - (offset & 7), // remaining bits in byte unread
                read = remaining < count ? remaining : count, // bits in this run
                shift = remaining - read,
                mask = (0xff >> (8 - read));

            value = (value << read) | ((currentByte & (mask << shift)) >> shift);

            offset += read;
            count -= read;
        }

        return value;
    };

    /**
     * Прочитать {count} бит со смещением с текущего места
     * @param count количество
     * @returns {number} результат чтения
     */
    BitBuffer.prototype.read = function (count) {
        const value = this.peek(count);
        this.index += count;
        return value;
    };

    /**
     * Пропустить {count} бит
     * @param count количество
     * @returns {*} указатель
     */
    BitBuffer.prototype.skip = function (count) {
        return (this.index += count);
    };

	/**
	 * Отмотать указатель на {count} бит или на 0
	 * @param count колдичество
	 */
	BitBuffer.prototype.rewind = function (count) {
        this.index = Math.max(this.index - count, 0);
    };

	/**
	 * Проверить осталось ли в буфере не прочитанной информации еще на {count} бит
	 * @param count количество
	 * @returns {boolean} да/нет
	 */
    BitBuffer.prototype.has = function (count) {
        return ((this.byteLength << 3) - this.index) >= count;
    };

    BitBuffer.MODE = {
        EVICT: 1,
        EXPAND: 2
    };

    return BitBuffer;
})();