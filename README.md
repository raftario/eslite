# `eslite`

Zero-dependency persistent JS objects using `node:sqlite`.
Requires Node.js 24 LTS.

## Usage

```ts
import { Database } from "eslite";

interface User {
    name: string;
    joined: Date;
    roles: string[];
    banned: boolean;
}

// `Database` implements `Disposable`.
using db = new Database("my.db");
// Tables are untyped and do not perform validation.
// You are responsible for the shape of the stored data.
// Any modification to the `user` record will me persisted.
const users = db.table("users") as Record<number, User>;

function isAdmin(id: number): boolean {
    const user = users[id];
    return !user.banned && user.roles.includes("admin");
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
