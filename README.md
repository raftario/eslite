# `eslite`

Zero-dependency persistent JS objects using `node:sqlite`.
Requires Node.js 24 LTS.

## Usage

`eslite` objects work pretty much like regular JavaScript objects, except all modifications are immediately persisted to a SQLite database.
It's basically like doing `fs.writeFile(JSON.stringify(object))` on every change, except it's much more convenient, much faster, and supports a wider range of data types.

Perfect for little side projects where you want to persist data without thinking too hard about how.

```ts
import { Database } from "eslite";

interface User {
    name: string;
    joined: Date;
    roles: string[];
    banned: boolean;
}

// `Database` implements `Disposable`
using db = new Database("login.db");
// A database file called `login.db` will be created,
// persisting all of the contents of the `users` object.
const users = db.table("users") as Record<number, User>;

function isAdmin(id: number): boolean {
    const user = users[id];
    if (!user) {
        return false;
    }

    return !user.banned && user.roles.includes("admin");
}

function makeAdmin(id: number): void {
    if (isAdmin(id)) {
        return;
    }

    const user = users[id];
    user.banned = false;
    user.roles.push("admin");
}

function register(id: number, name: string): void {
    if (id in users) {
        throw new Error("User already exists");
    }

    users[id] = {
        name,
        joined: new Date(),
        roles: [],
        banned: false,
    };
}
```

## Supported data types

- `null`
- `boolean`
- `number`
- `string`
- `bigint`
- `Date`
- `RegExp`
- Nested records and arrays of the former

## Performance

`eslite` will perform much better than de/serialising entire JSON objects on disk, but much worse than using a database normally.
Records and arrays are shallow, meaning accessing one of their keys/indices will lazily query the SQLite database.
This makes it possible to have very large databases without running into issues because only a small subset is ever loaded in memory,
but also makes some access patterns suboptimal.

Ultimately `eslite` is optimised for simplicity with good-enough performance, both in its usage and its implementation.

## License

Copyright Raphaël Thériault

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
