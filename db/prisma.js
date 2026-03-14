const { PrismaClient, Prisma } = require('@prisma/client')

const createPrismaWithSoftDelete = () => {
    const baseClient = new PrismaClient()

    // Extract models that actually have the 'isDeleted' field so we don't crash queries on models without it.
    const modelsWithSoftDelete = Prisma.dmmf.datamodel.models
        .filter(m => m.fields.some(f => f.name === 'isDeleted'))
        .map(m => m.name)

    const softDeleteExtension = {}
    modelsWithSoftDelete.forEach((modelName) => {
        softDeleteExtension[modelName] = {
            async findMany({ args, query }) {
                if (args.where?.isDeleted !== undefined) return query(args)
                args.where = { ...args.where, isDeleted: false }
                // Need to filter includes as well ideally, but basic isDeleted filter works for root.
                return query(args)
            },
            async findFirst({ args, query }) {
                if (args.where?.isDeleted !== undefined) return query(args)
                args.where = { ...args.where, isDeleted: false }
                return query(args)
            },
            async findUnique({ args, query }) {
                // For findUnique, if we inject isDeleted, it might throw error because findUnique requires unique criteria,
                // but if the model allows it, we do findFirst under the hood usually or we don't intercept findUnique.
                // We will leave findUnique alone for strict ID lookups, as soft deletes are typically filtered via findFirst/findMany.
                return query(args)
            },
            async count({ args, query }) {
                if (args.where?.isDeleted !== undefined) return query(args)
                args.where = { ...args.where, isDeleted: false }
                return query(args)
            }
        }
    })

    return baseClient.$extends({ query: softDeleteExtension })
}

let prisma

if (process.env.NODE_ENV === 'production') {
    prisma = createPrismaWithSoftDelete()
} else {
    if (!global.prisma) {
        global.prisma = createPrismaWithSoftDelete()
    }
    prisma = global.prisma
}

module.exports = prisma
